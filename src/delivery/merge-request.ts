import { canWriteProjectPath } from '../development/contracts.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { assertProjectCorrelation, projectRepositoryRoot, projectTarget } from '../business-engineering/project.js';
import { developmentHash } from '../development/contracts.js';
import type { createExecutionScope } from '../development/v2/execution-scope.js';
import type { PracticeConfig } from '../mastra/config.js';
import { hashSchema, lifecycleSchema, matchesAcceptancePlan, mergeRequestRetrySchema, qualityHash, testPlanSchema, testCaseSchema, type Lifecycle } from './contracts.js';
import { contentHash, formalRunBranch, publishReviewedCandidate, readHandoffFile } from './remote-handoff.js';
import { assertCandidate } from './testing.js';
import { createStageWorkspace } from '../mastra/stage-workspace.js';

const command = promisify(execFile);
const pullRefSchema = z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }) });
const confirmedTestSchema = z.object({ plan: testPlanSchema, cases: z.array(testCaseSchema), sourceHash: hashSchema });
const pullSchema = z.object({ number: z.number().int().positive(), state: z.string(), head: pullRefSchema, base: pullRefSchema });

/** 从服务端登记的 GitHub 仓库取得请求标识。 */
function githubRepository(origin: string) {
  const match = /^https:\/\/github\.com\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(origin);
  if (!match || match[2] === '.' || match[2] === '..') throw new Error('当前 MR 交付需要登记 GitHub 仓库');
  return `${match[1]}/${match[2]}`;
}

/** 通过固定 GitHub API 读取或创建请求，并验证远端回执。 */
export async function openMergeRequest(repository: string, branch: string, commit: string, sourceHash: string, reportHash: string) {
  const endpoint = `repos/${repository}/pulls`;
  /** 禁用交互，并将凭据留给宿主 gh 会话。 */
  async function api(method: 'GET' | 'POST', fields: string[] = [], path = endpoint) {
    const result = await command('gh', ['api', '--hostname', 'github.com', '--method', method, path, ...fields], {
      timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    });
    return JSON.parse(result.stdout) as unknown;
  }
  /** 按同仓库源分支查找，关闭或改目标的请求也参与对账。 */
  async function lookup() {
    const entries = z.array(z.object({ number: z.number().int().positive() })).parse(await api('GET', ['-f', 'state=all', '-f', `head=${repository.split('/')[0]}:${branch}`, '-f', 'per_page=100']));
    if (entries.length > 1) throw new Error('该 Run 分支有多个合并请求');
    return entries[0]?.number;
  }
  let number = await lookup();
  if (!number) {
    try {
      const body = `候选提交 ${commit}\n源码散列 ${sourceHash}\nQA 报告 ${reportHash}`;
      number = pullSchema.parse(await api('POST', ['-f', 'base=main', '-f', `head=${branch}`, '-f', `title=产研交付 ${branch}`, '-f', `body=${body}`])).number;
    } catch (error) {
      number = await lookup();
      if (!number) throw error;
    }
  }
  const pull = pullSchema.parse(await api('GET', [], `${endpoint}/${number}`));
  const sameRepository = [pull.head.repo, pull.base.repo].every(repo => repo.full_name.toLowerCase() === repository.toLowerCase());
  if (!sameRepository || pull.number !== number || pull.state !== 'open' || pull.base.ref !== 'main' || pull.head.ref !== branch || pull.head.sha !== commit) throw new Error('合并请求与当前交付版本不一致');
  return { number, url: `https://github.com/${repository}/pull/${number}`, branch, commit, base: 'main' as const, sourceHash, reportHash };
}

/** 绑定 Run 的规格、授权范围、候选文件和通过 QA 的散列。 */
export async function submitReviewedCandidate(config: PracticeConfig, state: Lifecycle, execution: ReturnType<typeof createExecutionScope>['port'], sourceHash: string, reportHash: string, ports: { read: typeof readHandoffFile; publish: typeof publishReviewedCandidate; open: typeof openMergeRequest } = { read: readHandoffFile, publish: publishReviewedCandidate, open: openMergeRequest }) {
  const root = projectRepositoryRoot(config);
  const target = projectTarget(config);
  const correlation = state.development.input.correlation;
  const testing = state.formalSpecifications?.filter(item => item.kind === 'testing').at(-1);
  const development = state.development.formalSpecification;
  const product = state.development.input.formalSpecifications?.filter(item => item.kind === 'product').at(-1);
  if (!root || !target || !correlation || !testing || !development || !product) throw new Error('交付缺少项目或正式规格');
  assertProjectCorrelation(config, correlation);
  const repository = githubRepository(target.origin);
  const branch = formalRunBranch(correlation.iterationId, correlation.runId);
  if (testing.upstreamCommits.join(',') !== [product.handoff.commit, development.handoff.commit].join(',')) throw new Error('交付规格的上游版本不一致');
  const specifications: Record<string, string> = {};
  const specPaths = [product, development, testing].flatMap(item => {
    if (item.handoff.branch !== branch) throw new Error('规格与 Run 分支不一致');
    for (const path of item.paths) specifications[path] = ports.read(root, { ...item.handoff, commit: testing.handoff.commit }, path);
    return item.paths;
  });
  const snapshot: Record<string, string> = {};
  for (const [path, hash] of Object.entries(state.development.delivery!.files)) {
    const content = await execution.readFile(path);
    if (contentHash(content) !== hash) throw new Error('读取候选时源码发生变化');
    snapshot[`candidate/${path}`] = content;
  }
  for (const [path, content] of Object.entries(specifications)) snapshot[`specifications/${path}`] = content;
  snapshot['evidence/quality.json'] = JSON.stringify(state.quality);
  const stage = await createStageWorkspace(`delivery-${correlation.runId}`, '交付 · 候选与 QA（只读）', snapshot);
  try {
  const read = async (path: string) => String(await stage.workspace.filesystem!.readFile(path, { encoding: 'utf8' }));
  const candidate: Record<string, string> = {};
  for (const [path, hash] of Object.entries(state.development.delivery!.files)) {
    const content = await read(`candidate/${path}`);
    if (contentHash(content) !== hash) throw new Error('交付 Workspace 候选版本不一致');
    candidate[path] = content;
  }
  const savedQuality = JSON.parse(await read('evidence/quality.json'));
  if (developmentHash(savedQuality) !== developmentHash(state.quality)) throw new Error('交付 Workspace QA 证据漂移');
  for (const path of specPaths) if (await read(`specifications/${path}`) !== specifications[path]) throw new Error('交付 Workspace 规格漂移');
  if (testing.paths.length !== 1) throw new Error('交付需要唯一的正式测试规格');
  const testPath = testing.paths[0]!;
  const testSpec = confirmedTestSchema.parse(JSON.parse(await read(`specifications/${testPath}`)));
  if (testSpec.sourceHash !== sourceHash || developmentHash(testSpec.plan) !== developmentHash(state.quality.plan) || developmentHash(testSpec.cases) !== developmentHash(state.quality.approval?.cases)) throw new Error('正式测试规格与通过的 QA 版本不一致');
  const project = state.development.input.project;
  const writable = (state.development.plan?.tasks.flatMap(task => task.paths) ?? []).filter(path => canWriteProjectPath(project, path));
  const commit = await ports.publish(root, testing.handoff, candidate, writable, specPaths, project.engineeringRevision ?? correlation.engineeringRevision);
  return ports.open(repository, branch, commit, sourceHash, reportHash);
  } finally { await stage.close(); }
}

/** QA 通过后进入交付。远端故障在同一原生节点暂停，重试复用候选和请求。 */
export function createMergeRequestDelivery(config: PracticeConfig, scope: ReturnType<typeof createExecutionScope>) {
  const submit = createStep({
    id: 'submit-merge-request', description: '核对候选与 QA 证据，向 main 提交 MR',
    inputSchema: lifecycleSchema, outputSchema: lifecycleSchema,
    suspendSchema: z.object({ hash: hashSchema, sourceHash: hashSchema, reportHash: hashSchema, reason: z.string() }),
    resumeSchema: mergeRequestRetrySchema,
    // 只有质量门放行才进入候选提交与远端操作。
    execute: async ({ inputData: state, resumeData, suspend }) => {
      if (state.outcome !== 'in-progress') return state;
      if (state.quality.status !== 'passed' || state.quality.review?.decision !== 'pass' || !matchesAcceptancePlan(state) || state.quality.sourceHash !== state.development.checkpointHash || state.quality.reportHash !== qualityHash(state)) throw new Error('交付缺少同版本 QA 放行证据');
      const sourceHash = state.development.checkpointHash;
      const reportHash = state.quality.reportHash;
      const hash = developmentHash({ sourceHash, reportHash, correlation: state.development.input.correlation, specifications: state.formalSpecifications });
      if (resumeData && resumeData.hash !== hash) throw new Error('MR 交付版本已变化');
      try { await assertCandidate(state, scope.port); }
      catch { return suspend({ hash, sourceHash, reportHash, reason: '候选源码与 QA 版本不一致，请核对候选检查点。' }); }
      if (config.mode === 'fixture') return { ...state, outcome: 'fixture-completed' as const };
      try {
        const mergeRequest = await submitReviewedCandidate(config, state, scope.port, sourceHash, reportHash);
        return { ...state, mergeRequest, outcome: 'delivery-confirmed' as const };
      } catch (error) {
        const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? '服务器无法启动 GitHub CLI。请联系维护者核对 gh 的安装和登录后重试。'
          : 'MR 交付未完成，请核对 Run 分支、候选版本和 GitHub 凭据后重试。';
        return suspend({ hash, sourceHash, reportHash, reason });
      }
    },
  });
  return createWorkflow({ id: 'delivery-team', description: '交付团队：提交并核验指向 main 的 MR', inputSchema: lifecycleSchema, outputSchema: lifecycleSchema }).then(scope.bind(submit)).commit();
}
