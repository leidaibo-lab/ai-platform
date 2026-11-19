/** 产品 Workflow 定义和工作台共用的节点名称与中文职责。 */
export const productSteps = [
  { id: 'align-product-requirements', title: '对齐需求', description: '明确目标、范围和业务规则，有关键缺口时等待用户补充。' },
  { id: 'product-writing', title: '生成待审规格', description: '生成需求文档和产品规格，校验并固化待审版本。' },
  { id: 'review-product-quality', title: '独立质量审查', description: '独立核对待审版本的业务规则、异常流程和验收覆盖。' },
  { id: 'review-product', title: '人工审批与交接', description: '由产品负责人审阅当前版本，批准后发布正式文档并交接研发。' },
] as const;

/** 将节点名称和中文职责写入 Mastra 的步骤描述。 */
export function describeProductStep(step: typeof productSteps[number]) {
  return `${step.title}｜${step.description}`;
}
