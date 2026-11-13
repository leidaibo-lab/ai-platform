/**
 * 使用全新隔离 Run 跑一遍 HRM 招聘需求的完整产研链路。
 * 该入口只用于本地受控 fixture：人工关口从当前暂停材料读取绑定值，
 * 不读取历史 Run，也不把 fixture 检查或本地回执描述成真实生产发布。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Mastra } from '@mastra/core';
import { readConfig } from '../src/mastra/config.ts';
import { createStudioApplicationOptions } from '../src/mastra/app.ts';
import { readIntake, respondIntake } from '../src/intake/service.ts';

const root = resolve(import.meta.dirname, '..');
const runId = randomUUID();
const runRoot = resolve(root, '.data', 'fresh-hrm-runs', runId);
const hrmRoot = process.env.HRM_REPOSITORY_ROOT ?? '/Users/Administrator/self-code/hrm';
mkdirSync(runRoot, { recursive: true, mode: 0o700 });

const base = readConfig();
const config = {
  ...base,
  mode: 'fixture',
  databaseUrl: `file:${resolve(runRoot, 'workflow.db')}`,
  hrmRepositoryRoot: hrmRoot,
};

const brief = [
  'HRM 招聘模块首期需求：让 HR 与用人负责人在一个地方协作完成候选人初筛和邀约记录，清楚知道当前谁需要处理以及处理结果，减少零散消息中的反复确认。',
  '本期只做候选人初筛与邀约结果记录，不进入面试安排；使用预置合成职位和候选人数据；业务角色和人工审批使用本地模拟标签，暂不建设真实账号认证。',
  '请形成可审阅的产品需求、实现任务、测试计划和发布交付记录；缺少影响业务行为的信息时提出澄清问题，建议与已确认规则分开。',
].join('\n');

const project = {
  id: 'hrm-recruitment-slice',
  files: {
    'src/recruitment-slice.mjs': 'export function fixtureValue() { return 1; }\n',
    'smoke.mjs': 'import { test } from "node:test"; import assert from "node:assert/strict"; import { fixtureValue } from "./src/recruitment-slice.mjs"; test("fixture candidate", () => assert.equal(fixtureValue(), 1));\n',
  },
  writablePaths: ['src/recruitment-slice.mjs'],
  checkFiles: ['smoke.mjs'],
  roles: ['backend'],
};

const actor = { reviewer: 'local-product-owner', comment: '本轮全新 HRM fixture Run；按当前暂停材料核对后继续，真实业务质量与线上发布另行验收。' };
const now = () => new Date().toISOString();

/** 根据当前暂停关口生成最小、可追溯的人工决定。 */
function gateData(current) {
  const gate = current.gate ?? {};
  const initial = gate.initial ?? {};
  if (current.step === 'review-product') return { ...actor, role: 'product', artifactHash: current.product.artifact.hash, decision: 'approve' };
  if (gate.key === 'confirm-project-scope') return { ...actor, project, maxReworks: 1 };
  if (gate.key === 'approve-architecture') return { ...actor, hash: initial.hash, decision: 'approve', resolutions: [] };
  if (gate.key === 'approve-test-cases') {
    const requirements = gate.evidence.requirements ?? [];
    return { ...actor, hash: initial.hash, decision: 'approve', cases: requirements.map((item, index) => ({ id: `hrm-case-${index + 1}`, requirementRefs: [item.id], expected: '候选初筛与邀约记录的已批准范围可被测试计划追踪。', method: 'registered-check', checkRefs: gate.evidence.registeredChecks ?? [] })) };
  }
  if (gate.key === 'review-test-results') return { ...actor, hash: initial.hash, decision: 'pass', manualResults: [], findings: [] };
  if (gate.key === 'approve-release-scope') return { ...actor, hash: initial.hash, decision: 'approve', scope: { environment: 'local-fixture', artifactDigest: 'a'.repeat(64), artifactRef: `local://hrm/${runId}`, rollbackArtifactRef: `local://hrm/rollback/${runId}`, healthChecks: [{ id: 'fixture-health', expected: '受控候选与交付索引存在' }] } };
  if (gate.key === 'execute-release-externally') return { releaseHash: initial.releaseHash, sourceHash: initial.sourceHash, artifactDigest: initial.artifactDigest, environment: initial.environment, status: 'succeeded', jobRef: `local-fixture-${runId}`, operator: 'local-operator', finishedAt: now(), notes: 'fixture 本地回执；未调用外部 CI/CD。' };
  if (gate.key === 'verify-release-health') return { releaseHash: initial.releaseHash, deploymentReceiptHash: initial.deploymentReceiptHash, operator: 'local-operator', checks: (gate.evidence.requiredChecks ?? []).map(check => ({ id: check.id, status: 'passed', evidence: '本地归档文件与流程状态已存在。', observedAt: now() })) };
  throw new Error(`未登记的人工关口：${gate.key}`);
}

/** 从完整 Run 快照中提取可提交的交付投影，避免复制历史数据。 */
function summary(snapshot) {
  return {
    runId,
    workflow: 'productDevelopmentWorkflow',
    mode: 'fixture',
    brief,
    outcome: snapshot.outcome ?? null,
    status: snapshot.status,
    generatedAt: now(),
    limitation: '本轮为 fixture 全流程验证；不等同于真实模型质量、真实 HRM 业务验收、CI/CD 发布或 PR 合并。',
    source: '本脚本创建的全新 SQLite Run，不读取历史 Run 的业务产物、批准或答案。',
  };
}

const options = createStudioApplicationOptions(config);
new Mastra(options);
await options.storage.init();
try {
  const workflow = options.workflows.productDevelopmentWorkflow;
  const run = await workflow.createRun({ runId });
  let result = await run.start({ inputData: { brief, iterationId: `hrm-fresh-${runId.slice(0, 8)}`, guidedIntake: false } });
  const gates = [];
  for (let count = 0; result.status === 'suspended' && count < 40; count += 1) {
    const current = await readIntake(workflow, runId);
    if (!current.gate && current.step !== 'review-product') throw new Error(`暂停点没有可操作关口：${current.step ?? 'unknown'}`);
    const data = gateData(current);
    const response = current.step === 'review-product'
      ? await respondIntake(workflow, 'fixture', runId, data, config)
      : await respondIntake(workflow, 'fixture', runId, { gateHash: current.humanGate?.gateHash ?? current.gate.gateHash, data }, config);
    gates.push({ step: current.step, key: current.gate?.key ?? 'review-product', decision: data.decision ?? 'submitted' });
    result = response;
  }
  const final = await readIntake(workflow, runId);
  const record = { ...summary(final), gates, final: { outcome: final.outcome, step: final.step, status: final.status } };
  writeFileSync(resolve(runRoot, 'run-summary.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ runId, runRoot, hrmRoot, status: final.status, outcome: final.outcome, gates: gates.length }, null, 2));
  if (final.status !== 'success') process.exitCode = 1;
} finally {
  await options.storage.close();
}
