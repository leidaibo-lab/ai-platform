import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProductQualityLoop, validateProductAssessment, validateProductFindingVerification } from '../src/team/product-quality-loop.js';

const content = '# 需求文档\n- REQ-A: 初始规则 | 验收: 可观察结果\n# 产品规格\n- TASK-A: 交付能力 | 需求: REQ-A\n';
const hash = 'a'.repeat(64);
/** 为当前版本生成可核对的审查发现。 */
function assessment(productHash: string, findings = true) {
  return { productHash, summary: '审查结论', findings: findings ? [{ id: 'F-1', productHash, detail: '需要完善已有规则表述', quote: '可观察结果', action: 'repair' as const }] : [] };
}

test('产品审查拒绝版本漂移、伪造证据和未完整核验', () => {
  assert.throws(() => validateProductAssessment(content, hash, assessment('b'.repeat(64))), /版本/);
  assert.throws(() => validateProductAssessment(content, hash, { ...assessment(hash), findings: [{ ...assessment(hash).findings[0], quote: '不存在' }] }), /正文证据/);
  assert.throws(() => validateProductFindingVerification(assessment(hash), { productHash: hash, decisions: [] }), /全部发现/);
});

test('核实成立后自动修订，独立复审绑定修订版本', async () => {
  const versions: string[] = [];
  const result = await runProductQualityLoop({ content, hash, maxRepairs: 2 }, {
    review: async (_content, version) => { versions.push(version); return assessment(version, versions.length === 1); },
    verify: async (_content, report) => ({ productHash: report.productHash, decisions: report.findings.map(item => ({ id: item.id, decision: 'confirmed', reason: '正文核实成立' })) }),
    repair: async candidate => candidate.replace('初始规则', '完善规则'),
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.rounds.length, 2);
  assert.notEqual(versions[0], versions[1]);
  assert.equal(result.rounds.at(-1)!.productHash, result.productHash);
});

test('误报保留否决证据，不触发修订', async () => {
  const result = await runProductQualityLoop({ content, hash, maxRepairs: 2 }, {
    review: async () => assessment(hash),
    verify: async () => ({ productHash: hash, decisions: [{ id: 'F-1', decision: 'false-positive', reason: 'TASK-A 已引用 REQ-A' }] }),
    repair: async () => { throw new Error('误报不应修订'); },
  });
  assert.equal(result.status, 'passed');
  assert.match(result.rounds[0]!.verification.decisions[0]!.reason, /TASK-A/);
});

test('业务决定、重复候选及预算耗尽分别停止', async () => {
  for (const kind of ['business', 'repeat', 'budget']) {
    let calls = 0;
    const result = await runProductQualityLoop({ content, hash, maxRepairs: 2 }, {
      review: async (_text, version) => assessment(version),
      verify: async (_text, report) => ({ productHash: report.productHash, decisions: [{ id: 'F-1', decision: kind === 'business' ? 'business-decision' : 'confirmed', reason: '核验理由' }] }),
      repair: async candidate => { calls++; return kind === 'repeat' ? candidate : candidate.replace('初始规则', '完善规则') + `\n说明${calls}`; },
    });
    assert.equal(result.status, kind === 'business' ? 'business-decision' : kind === 'repeat' ? 'no-progress' : 'repair-budget');
    assert.equal(calls, kind === 'business' ? 0 : kind === 'repeat' ? 1 : 2);
  }
});

test('修订调用失败后恢复沿用已消费预算与核验，不重跑已保存审查', async () => {
  let checkpoint: any;
  await assert.rejects(runProductQualityLoop({ content, hash, maxRepairs: 2 }, {
    review: async () => assessment(hash),
    verify: async () => ({ productHash: hash, decisions: [{ id: 'F-1', decision: 'confirmed', reason: '核实成立' }] }),
    repair: async () => { throw new Error('synthetic interrupted repair'); },
  }), (error: any) => { checkpoint = error.productQualityCheckpoint; return true; });
  assert.equal(checkpoint.repairs, 1);
  let repaired = 0;
  const result = await runProductQualityLoop({ content, hash, maxRepairs: 2, checkpoint }, {
    review: async (_content, version) => { assert.notEqual(version, hash); return assessment(version); },
    verify: async (_content, report) => ({ productHash: report.productHash, decisions: [{ id: 'F-1', decision: 'confirmed', reason: '核实成立' }] }),
    repair: async candidate => { repaired++; return candidate + '\n修订'; },
  });
  assert.equal(repaired, 1);
  assert.equal(result.status, 'repair-budget');
});

test('产品原生审查步骤自动修订后送审的是复审通过的同版本', async () => {
  const { createProductManagerPhases } = await import('../src/mastra/workflows/product-manager.js');
  const { createTeamRunPolicy } = await import('../src/team/run-policy.js');
  const { deliverySchema } = await import('../src/mastra/workflows/delivery.js');
  let reviews = 0;
  let repairs = 0;
  /** 合成模型回执仅验证宿主编排与版本绑定。 */
  function output(text: string) {
    return { text, finishReason: 'stop', steps: [{ text }], toolResults: [{ payload: { toolName: 'mastra_workspace_read_file', args: { path: 'product.md' }, result: content } }] };
  }
  const agents = {
    productReviewerAgent: { generate: async (prompt: string) => {
      const input = JSON.parse(prompt);
      if (input.task === 'product-structured-quality-review') return output(JSON.stringify(assessment(input.productHash, ++reviews === 1)));
      if (input.task === 'product-finding-verification') return output(JSON.stringify({ productHash: input.assessment.productHash, decisions: input.assessment.findings.map((item: any) => ({ id: item.id, decision: 'confirmed', reason: '合成核验' })) }));
      throw new Error('不应执行旧自由文本审查');
    } },
    productManagerAgent: { stream: async () => ({ getFullOutput: async () => { repairs++; return output(content.replace('初始规则', '修订规则')); } }) },
  };
  const phases = createProductManagerPhases(agents as any, 'live');
  assert.equal(phases.graph, 'flat');
  if (phases.graph !== 'flat') throw new Error('图不符');
  const input = deliverySchema.parse({ brief: '合成业务需求', mode: 'live', productHandoffFormat: 'paired-markdown.v1', teamRunPolicy: createTeamRunPolicy(), artifacts: [{ stage: 'product', content, hash, evidence: 'model-proposal' }], reviews: [], outcome: 'in-progress' });
  const result = await phases.qualityReview.execute({ inputData: input, runId: 'synthetic-quality-loop', abortSignal: new AbortController().signal } as any) as typeof input;
  assert.equal(repairs, 1);
  assert.equal(reviews, 2);
  assert.equal(result.productQualityReview?.loop?.status, 'passed');
  assert.equal(result.productQualityReview?.productHash, result.artifacts.at(-1)!.hash);
  assert.match(result.artifacts.at(-1)!.content, /修订规则/);
});

test('业务待决或复审失败的版本拒绝批准，仍允许人工退回', async () => {
  const { createProductTeamWorkflow } = await import('../src/mastra/workflows/product-team.js');
  const { createTeamRunPolicy } = await import('../src/team/run-policy.js');
  const { deliverySchema } = await import('../src/mastra/workflows/delivery.js');
  const workflow = createProductTeamWorkflow({} as any, { mode: 'fixture', rootDir: process.cwd(), databaseUrl: 'file::memory:', modelId: 'openai/fixture', port: 4111 } as any);
  const input = deliverySchema.parse({ brief: '合成业务需求', mode: 'fixture', teamRunPolicy: createTeamRunPolicy(), artifacts: [{ stage: 'product', content, hash, evidence: 'fixture' }], reviews: [], outcome: 'in-progress', productQualityReview: { version: 'product-quality-review.v1', agent: 'product-reviewer-agent', productHash: hash, hash, content: '业务待决', toolNames: [], loop: { status: 'business-decision', repairs: 0, rounds: [] } } });
  const step = workflow.steps['review-product'];
  const review = { role: 'product', artifactHash: hash, decision: 'approve', reviewer: 'fixture-user', comment: '合成批准' };
  await assert.rejects(step.execute({ inputData: input, resumeData: review } as any), /复审未通过/);
  let outcome: unknown;
  await step.execute({ inputData: input, resumeData: { ...review, decision: 'rework' }, bail: (value: any) => { outcome = value.outcome; } } as any);
  assert.equal(outcome, 'rework-requested');
});
