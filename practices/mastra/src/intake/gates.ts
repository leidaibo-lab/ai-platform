/** 业务关口白名单：复用已有 Zod 契约，不接受客户端指定步骤或执行命令。 */
import { z } from 'zod';
import { developmentHash, projectSchema, recoveryReviewSchema } from '../development/contracts.js';
import { stateV2Schema, approvalHashV2, recoveryHashV2, findingsHashV2, approvalV2Schema, findingsReviewSchema } from '../development/v2/contracts.js';
import { applyFindingsReview, assertApprovalV2 } from '../development/v2/gates.js';
import { validateCases, validateQualityReview } from '../delivery/testing.js';
import { lifecycleSchema, planApprovalSchema, qualityReviewSchema, releaseApprovalSchema, deploymentReceiptSchema, healthReceiptSchema, rollbackReceiptSchema } from '../delivery/contracts.js';
export const scopeFormSchema = z.object({ project: projectSchema, reviewer: z.string().trim().min(1).max(100), comment: z.string().trim().min(1).max(2000), maxReworks: z.number().int().min(0).max(3).default(1) });
const definitions: Record<string, { title: string; description: string; schema: z.ZodType }> = {
  'confirm-project-scope': { title: '确认开发项目', description: '确认已关联项目和整体权限边界，具体文件、角色与检查映射由开发团队规划，方案批准后才实施。', schema: scopeFormSchema },
  'approve-architecture': { title: '确认开发方案', description: '阅读任务、接口、风险及团队安排。批准后将在已授权的隔离候选目录中执行实现和检查。', schema: approvalV2Schema },
  'resolve-readiness': { title: '处理开工前的待决问题', description: '逐项记录判断依据；无法解决时可终止，不能用批准掩盖阻塞。', schema: findingsReviewSchema },
  'resolve-findings': { title: '处理评审发现', description: '对当前报告逐项裁决；通过已有门禁后才继续交付。', schema: findingsReviewSchema },
  'recover-development': { title: '决定是否接续开发', description: '阅读失败阶段和原因，选择从已保存检查点重试或停止。', schema: recoveryReviewSchema },
  'approve-test-cases': { title: '确认测试用例', description: '逐项确认需求、预期结果与检查映射；提交后实际执行已登记的检查。', schema: planApprovalSchema },
  'review-test-results': { title: '确认测试结果', description: '查看自动检查证据，补齐人工用例结果，再决定通过、返工或停止。', schema: qualityReviewSchema },
  'approve-release-scope': { title: '确认发布范围', description: '确认环境、真实制品、健康检查和回滚引用。此步骤保存发布授权，不会代替外部平台执行。', schema: releaseApprovalSchema },
  'execute-release-externally': { title: '填写发布执行回执', description: '请在外部平台执行已批准的发布，再填写真实任务引用和执行结果。不要填入密钥。', schema: deploymentReceiptSchema },
  'verify-release-health': { title: '确认发布后健康检查', description: '按批准清单填写实际观测结果和证据；失败会进入回滚处理。', schema: healthReceiptSchema },
  'execute-rollback-externally': { title: '填写回滚执行回执', description: '在外部平台完成回滚后填写真实回执；无法恢复时明确标为需要人工处理。', schema: rollbackReceiptSchema },
};
export type GatePayload = Record<string, any>;
/** 服务端生成只读绑定值，不让用户手工抄写版本与发布标识。 */
export function gateInitial(key: string, payload: GatePayload) {
  const fixed: Record<string, unknown> = {};
  if (payload.hash) fixed.hash = payload.hash;
  if (key === 'approve-test-cases') fixed.hash = payload.plan?.hash;
  if (key === 'approve-release-scope') fixed.hash = payload.packageHash;
  for (const name of ['sourceHash', 'releaseHash', 'deploymentReceiptHash', 'artifactDigest', 'environment', 'rollbackArtifactRef']) if (payload[name] !== undefined) fixed[name] = payload[name];
  return fixed;
}
/** 只投影白名单关口和当前实际材料，未知暂停点保持不可操作。 */
export function describeGate(path: string, payload: GatePayload) {
  const key = path.split('.').at(-1)!;
  const definition = definitions[key];
  if (!definition) return undefined;
  const schema = z.toJSONSchema(definition.schema, { unrepresentable: 'any' });
  const fixed = Object.fromEntries(Object.entries(gateInitial(key, payload)).filter(/** 只绑定本关口真正接收的字段，避免展示材料被误当作回执输入。 */([name]) => name in (schema.properties ?? {})));
  if (key === 'approve-test-cases') {
    const fields = (schema.properties?.cases as any)?.items?.properties;
    if (fields) {
      fields.requirementRefs.items.enum = payload.requirements.map(/** 选项来自已批准需求引用。 */(item: GatePayload) => item.id);
      fields.requirementRefs.items['x-labels'] = Object.fromEntries(payload.requirements.map(/** 显示需求正文而非要求手抄锚点。 */(item: GatePayload) => [item.id, `${item.id} · ${item.text.slice(0, 100)}`]));
      fields.checkRefs.items.enum = payload.registeredChecks;
    }
  }
  const initial: GatePayload = { ...fixed };
  if (key === 'resolve-readiness' || key === 'resolve-findings') initial.decisions = (payload.report ? [payload.report] : payload.reports ?? []).flatMap(/** 按真实报告预填引用，裁决结论与理由必须由人填写。 */(report: GatePayload) => report.assessment.findings.map(/** 报告版本自动绑定到每项发现。 */(finding: GatePayload) => ({ reportHash: report.hash, findingId: finding.id, decision: '', reason: '', refs: finding.refs })));
  if (key === 'confirm-project-scope') initial.project = { id: '', files: {}, writablePaths: [''], checkFiles: [''], roles: [''] };
  if (key === 'approve-test-cases') initial.cases = (payload.requirements ?? []).map(/** 只预填引用与空用例，不替人决定预期或映射。 */(item: GatePayload, index: number) => ({ id: `case-${index + 1}`, requirementRefs: [item.id], expected: '', method: '', checkRefs: [] }));
  if (key === 'review-test-results') initial.manualResults = (payload.quality?.approval?.cases ?? []).filter(/** 机器结果不能被人工填报覆盖。 */(item: GatePayload) => item.method === 'manual').map(/** 结果与证据保持空白，必须实际填报。 */(item: GatePayload) => ({ caseId: item.id, status: '', evidence: '' }));
  if (key === 'verify-release-health') initial.checks = (payload.requiredChecks ?? []).map(/** 检查清单是已批准事实，实际结果不预选。 */(item: GatePayload) => ({ id: item.id, status: '', evidence: '', observedAt: '' }));
  return { initial, key, title: definition.title, description: definition.description, gateHash: developmentHash({ path, payload }), evidence: payload, fixed, schema };
}
/** 输入结构与所有绑定值在恢复前核对，拒绝过期和跨关口请求。 */
export function validateGate(path: string, payload: GatePayload, input: unknown, savedState?: unknown) {
  const gate = describeGate(path, payload);
  if (!gate) throw new Error('未登记的人工关口');
  const envelope = z.object({ gateHash: z.string().length(64), data: z.unknown() }).parse(input);
  if (envelope.gateHash !== gate.gateHash) throw new Error('确认材料已变化，请刷新');
  const data = definitions[gate.key].schema.parse(envelope.data) as GatePayload;
  for (const [name, value] of Object.entries(gate.fixed)) if (data[name] !== value) throw new Error('绑定版本不匹配');
  if (gate.key === 'approve-architecture' && data.resolutions.length) throw new Error('方案确认不能替代发现裁决');
  if (gate.key === 'approve-release-scope' && new Set(data.scope.healthChecks.map(/** 健康清单标识必须唯一。 */(check: GatePayload) => check.id)).size !== data.scope.healthChecks.length) throw new Error('健康检查重复');
  if (gate.key === 'verify-release-health') {
    const actual = new Set(data.checks.map(/** 不允许重复结果补足遗漏。 */(check: GatePayload) => check.id));
    if (actual.size !== data.checks.length || actual.size !== payload.requiredChecks.length || payload.requiredChecks.some(/** 每个批准检查必须回填。 */(check: GatePayload) => !actual.has(check.id))) throw new Error('健康结果必须覆盖批准清单');
  }
  if (['approve-architecture', 'resolve-readiness', 'resolve-findings', 'recover-development'].includes(gate.key)) {
    const state = stateV2Schema.parse(savedState);
    if (gate.key === 'approve-architecture') { assertApprovalV2(state); if (data.hash !== approvalHashV2(state)) throw new Error('方案版本发生漂移'); }
    if (gate.key === 'resolve-readiness' || gate.key === 'resolve-findings') { if (data.hash !== findingsHashV2(state)) throw new Error('报告版本发生漂移'); applyFindingsReview(state, findingsReviewSchema.parse(data)); }
    if (gate.key === 'recover-development' && data.hash !== recoveryHashV2(state)) throw new Error('恢复版本发生漂移');
  }
  if (gate.key === 'approve-test-cases' || gate.key === 'review-test-results') {
    const state = lifecycleSchema.parse(savedState);
    if (gate.key === 'approve-test-cases' && data.decision === 'approve') validateCases(state, planApprovalSchema.parse(data));
    if (gate.key === 'review-test-results') validateQualityReview(state, qualityReviewSchema.parse(data));
  }
  return data;
}
