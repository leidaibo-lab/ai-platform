/** 原生 Time travel 的业务白名单；只恢复产品阶段的生成/发布，不开放任意步骤跳转。 */
import { deliverySchema } from '../mastra/workflows/delivery.js';
import { productRoles } from '../mastra/workflows/product-contract.js';
import { developmentHash } from '../development/contracts.js';
const titles: Record<string, string> = { 'guided-requirements.requirements-round.analyze-requirements': '需求分析', 'draft-product.product-coordinator': '总产品统筹', 'draft-product.product-clarification': '需求梳理', 'draft-product.product-closure': '产品闭环检查', 'draft-product.product-writing': '产品写作', 'draft-product.publish-product': '产品稿发布' };
/** 从失败叶节点与已保存输入派生恢复计划；下游存在批准或交付时不开放重放。 */
export function describeRecovery(runId: string, status: string, steps: Record<string, any>) {
  if (status !== 'failed') return undefined;
  const failed = Object.entries(steps).find(/** 排除容器失败，选择明确登记的业务叶节点。 */([name, value]) => name in titles && !Array.isArray(value) && value.status === 'failed');
  if (!failed) return undefined;
  const [path, entry] = failed;
  const parsed = deliverySchema.safeParse(entry.payload);
  if (!parsed.success || parsed.data.artifacts.length || parsed.data.reviews.length) return undefined;
  const state = parsed.data;
  const entries = state.productWork?.entries ?? [];
  const roleIndex = path === 'draft-product.publish-product' ? 4 : productRoles.findIndex(/** 本次只重做失败角色及后续，之前产物必须顺序完整。 */role => path === `draft-product.product-${role}`);
  if (path.startsWith('draft-product.') && (roleIndex < 0 || entries.length !== roleIndex || entries.some(/** 防止缺少前序或混入重复角色的快照直接恢复。 */(value, index) => value.role !== productRoles[index]))) return undefined;
  const preserved = entries.map(/** 已完成产物保持只读，不再调用对应角色。 */value => ({ label: titles[`draft-product.product-${value.role}`], role: value.role }));
  return {
    hash: developmentHash({ runId, step: path, state, endedAt: entry.endedAt, error: entry.error?.name }),
    step: path, title: titles[path], savedAnswers: state.intake?.history.length ?? 0, preserved,
    reason: [408, 504, 524].includes(entry.error?.statusCode) ? '模型服务响应超时' : entry.error?.name === 'AI_APICallError' ? '上游模型调用未成功' : entry.error?.name === 'SyntaxError' || entry.error?.name === 'ZodError' ? '模型输出未通过格式校验' : '此步骤执行未完成',
    message: `可以从“${titles[path]}”的已保存输入继续，无需重填已确认信息。`,
    impact: path === 'draft-product.publish-product' ? '重新整理已有产品稿并生成版本，随后等待人工确认。' : '重新调用该步骤及后续所需的模型；前面已完成的产物保留。生成完整产品稿后仍需人工确认。',
  };
}
