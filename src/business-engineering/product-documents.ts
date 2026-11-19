import { assetIdSchema } from '../delivery/asset-identity.js';
import { acceptanceRequirementsInstruction, readAcceptanceRequirements } from './acceptance-requirements.js';

export const productDocumentsInstruction = `${acceptanceRequirementsInstruction}
输出同一待审 Markdown 的两份正文，只使用两个一级标题，依次为“# 需求文档”和“# 产品规格”。需求文档写目标、范围和业务规则，按能力保留 Requirement / Scenario（WHEN、THEN）等可观察场景。所有 REQ 条目只在需求文档中声明，放在对应业务规则附近。输入已含可用的 Requirement / Scenario 时，保留其已确认规则与场景，补齐规则已有依据的可观察边界。归档模板中的 TBD Purpose 应改为明确业务目标。
产品规格只拆分可单独交付的任务，说明交付结果并引用需求 ID。每个任务独立占一行，格式为“- TASK-大写英文或数字标识: 任务及预期交付结果 | 需求: REQ-标识, REQ-标识”。任务 ID 唯一，每项需求至少被一个任务覆盖。产品任务不给出实现文件或技术选型，不复制需求正文。输出不要用代码围栏包裹。`;

/** 使用未经缩写的迭代标识归集文档，避免不同需求路径因分支名归一化而重合。 */
export function productPaths(iterationId: string) {
  const directory = `product/${assetIdSchema.parse(iterationId)}`;
  return { requirements: `${directory}/requirements.md`, specification: `${directory}/product-spec.md` };
}

/** 从同一审批正文拆出两份文件，先校验任务和需求的对应关系。 */
export function readProductDocuments(content: string) {
  const lines = content.split(/\r?\n/);
  const headings: { title: string; line: number }[] = [];
  let fence: string | undefined;
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1]!.startsWith(fence) && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (!fence && /^ {0,3}#\s/.test(line)) headings.push({ title: line.trim(), line: index });
  }
  const [requirementsHeading, specificationHeading] = headings;
  if (fence || headings.length !== 2 || requirementsHeading?.title !== '# 需求文档' || requirementsHeading.line !== 0 || specificationHeading?.title !== '# 产品规格') {
    throw new Error('待审稿须依次包含「# 需求文档」和「# 产品规格」两份正文');
  }
  const requirements = `${lines.slice(0, specificationHeading.line).join('\n').trimEnd()}\n`;
  const specification = `${lines.slice(specificationHeading.line).join('\n').trimEnd()}\n`;
  const requirementIds = new Set(readAcceptanceRequirements(requirements).map(/** 索引本版本中已声明的需求 ID。 */item => item.id));
  const taskIds = new Set<string>();
  const coveredIds = new Set<string>();
  for (const line of specification.split('\n')) {
    if (/^\s*[-*+]\s+(?:\*\*)?REQ-/i.test(line)) throw new Error('需求条目必须声明在需求文档中');
    if (!/^\s*[-*+]\s+(?:\*\*)?TASK-/i.test(line)) continue;
    const task = /^- (TASK-[A-Z0-9]+(?:-[A-Z0-9]+)*):\s*(.+?)\s*\|\s*需求[:：]\s*(.+)$/.exec(line.trim());
    if (!task || !task[2]!.trim() || taskIds.has(task[1]!)) throw new Error('产品任务格式无效或 ID 重复');
    taskIds.add(task[1]!);
    const refs = task[3]!.split(/[,，]/).map(/** 去除模型输出中的分隔空白。 */ref => ref.trim());
    if (new Set(refs).size !== refs.length || refs.some(/** 任务只引用当前正文的需求。 */ref => !requirementIds.has(ref))) throw new Error(`产品任务 ${task[1]} 的需求引用未知或重复`);
    for (const ref of refs) coveredIds.add(ref);
  }
  if (coveredIds.size !== requirementIds.size) throw new Error('产品任务须覆盖需求文档中的全部需求 ID');
  return { requirements, specification };
}
