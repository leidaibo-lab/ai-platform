/** 质量门到 Git 的薄 Adapter；原生 Step 持有暂停/恢复，Git 持有版本与网络事实。
 * ADR: docs/decisions/2026-11-09-mastra-code-publication.md
 */
import { createStep } from '@mastra/core/workflows';
import { developmentHash } from '../development/contracts.js';
import type { ExecutionPort } from '../development/v2/execution-scope.js';
import type { PracticeConfig } from '../mastra/config.js';
import { assertCandidate } from './testing.js';
import { codePublicationSchema, lifecycleSchema, qualityHash, type Lifecycle } from './contracts.js';
import { contentHash, publishCodeHandoff, repositoryRetrySchema, repositorySyncPauseSchema } from './remote-handoff.js';
import { resolveRemoteSyncTarget } from './remote-sync-settings.js';
import { validateRepository } from './asset-files.js';
import { assertApprovalV2, checksPassedV2 } from '../development/v2/gates.js';

/** 宿主从已验收候选读取源码，拒绝质量、计划、权限或版本漂移后才调用 Git。 */
export async function publishQualifiedCode(state: Lifecycle, execution: ExecutionPort, root: string, publish = publishCodeHandoff) {
  await assertCandidate(state, execution);
  const dev = state.development;
  assertApprovalV2(dev);
  const repository = dev.input.project.repository;
  if (!repository || !dev.input.scopeApproval || dev.input.scopeApproval.productHash !== dev.input.source.hash || !dev.plan || dev.planHash !== developmentHash(dev.plan) || !dev.approvalHash || dev.approvedHash !== dev.approvalHash || dev.delivery!.approvalHash !== dev.approvalHash || dev.delivery!.productHash !== dev.input.source.hash || dev.delivery!.planHash !== dev.planHash || state.quality.status !== 'passed' || state.quality.review?.decision !== 'pass' || state.quality.sourceHash !== dev.checkpointHash || state.quality.reportHash !== qualityHash(state) || !checksPassedV2({ ...dev, checks: state.quality.checks }) || state.quality.checks.some(
    /** 不把失败、截断或超时进程的报告作为代码回库资格。 */
    check => check.exitCode !== 0 || check.processExitCode !== 0 || check.timedOut || check.stdoutTruncated || check.stderrTruncated,
  )) throw new Error('源码回库缺少同版本项目批准、研发交付或独立测试通过证据');
  const files: Record<string, string> = {};
  for (const path of Object.keys(dev.delivery!.files)) files[path] = await execution.readFile(path);
  await assertCandidate(state, execution);
  const allowedPaths = dev.plan.tasks.flatMap(/** 仅批准任务拥有的路径能进入源码差异。 */task => task.paths);
  const hashes: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) hashes[path] = contentHash(content);
  if (developmentHash(hashes) !== dev.checkpointHash) throw new Error('读取源码期间候选检查点漂移');
  for (const path of allowedPaths) if (dev.input.project.checkFiles.includes(path) || !(dev.input.project.writablePaths.includes(path) || dev.input.project.writableRoots?.some(/** 新增文件只在固定源码上界内。 */root => path.startsWith(`${root}/`)))) throw new Error('源码任务超出项目授权');
  const receipt = await publish(root, dev.input.correlation?.runId ?? dev.input.source.runId, { baselineCommit: repository.baseCommit, baselineFiles: dev.input.project.files, candidateFiles: files, allowedPaths, sourceHash: dev.checkpointHash, qualityHash: state.quality.reportHash! });
  return codePublicationSchema.parse({ version: 'code-publication.v1', baselineCommit: repository.baseCommit, sourceHash: dev.checkpointHash, qualityHash: state.quality.reportHash, receipt });
}

/** live 主链测试通过即提交代码；失败原生暂停，恢复仅重试当前同版本源码。 */
export function createCodePublicationStep(config: PracticeConfig, execution: ExecutionPort, publish = publishCodeHandoff) {
  return createStep({ id: 'publish-tested-code', description: '将独立测试通过的业务源码提交并推送到项目交接分支', inputSchema: lifecycleSchema, outputSchema: lifecycleSchema, resumeSchema: repositoryRetrySchema, suspendSchema: repositorySyncPauseSchema,
    /** 同步配置只允许选中已经确认的开发仓库，不能将源码发到其他资料目标。 */
    execute: async ({ inputData: state, resumeData, suspend }) => {
      if (state.outcome !== 'in-progress' || config.mode !== 'live') return state;
      const retryKey = developmentHash({ runId: state.development.input.source.runId, sourceHash: state.development.checkpointHash, qualityHash: state.quality.reportHash, repository: state.development.input.project.repository });
      if (resumeData && resumeData.repositoryRetry !== retryKey) throw new Error('源码同步重试版本不一致');
      try {
        const target = resolveRemoteSyncTarget(config, 'publish-tested-code');
        const repository = state.development.input.project.repository;
        if (!target || !repository || target.origin !== repository.origin) throw new Error('源码同步目标必须匹配已确认的开发项目');
        const root = validateRepository(target.root, repository.origin);
        const codePublication = await publishQualifiedCode(state, execution, root, publish);
        return { ...state, codePublication };
      } catch {
        return suspend({ kind: 'repository-sync', mode: config.mode, retryKey, stage: 'publish-tested-code', reason: '业务源码尚未完成远端提交。请检查开发阶段同步目标、Git 基线与授权、候选和质量版本；修复后重试，仅同步源码，不重新调用模型。历史 Run 缺少项目基线时需重新确认项目。' });
      }
    },
  });
}
