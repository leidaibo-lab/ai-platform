/** 研发 Workflow 和工作台共用的节点名称与中文职责。 */
export const developmentSteps = [
  { id: 'confirm-project-scope', title: '确认项目与权限', description: '确认仓库、代码基线、可写范围和受保护检查。' },
  { id: 'plan-development', title: '生成开发方案', description: '核实工程上下文，生成技术方案、任务分工和执行团队。' },
  { id: 'assess-readiness', title: '独立就绪审查', description: '核对需求覆盖、任务依赖和开工条件，有疑问时等待人工裁决。' },
  { id: 'approve-architecture', title: '人工审批开工', description: '人工批准当前版本的方案、团队和执行预算。' },
  { id: 'develop-and-check', title: '按方案实施与验证', description: '按依赖执行任务，合并候选改动并运行登记检查。' },
  { id: 'review-development-quality', title: '独立代码评审与交接', description: '审查通过固定检查的候选版本，核对交付证据并交给测试。' },
] as const;

/** 将中文节点名称和职责写入 Mastra 的步骤描述。 */
export function describeDevelopmentStep(step: typeof developmentSteps[number]) {
  return `${step.title}｜${step.description}`;
}
