import { assetIdSchema } from '../delivery/asset-identity.js';
import { readAcceptanceRequirements } from './acceptance-requirements.js';

const acceptanceRequirementsInstruction = '增加“可验收需求”清单。每个条目使用独立的一行，格式严格为“- REQ-大写英文或数字标识: 业务规则 | 验收: 可观察的预期结果”。ID 由业务能力命名，例如 REQ-APPLICATION-SUBMIT，不使用行号。同一需求修订、移动时保留原 ID，新增需求分配新 ID，移除需求的 ID 不复用。条目必须覆盖本期可独立验收的业务规则与关键异常，不能引入未经确认的规则。最多100项。';

export { acceptanceRequirementsInstruction };

export const productDocumentsInstruction = `${acceptanceRequirementsInstruction}
输出同一待审 Markdown 的两份正文，只使用两个一级标题，依次为“# 需求文档”和“# 产品规格”。需求文档写目标、范围和业务规则，按能力保留 Requirement / Scenario（WHEN、THEN）等可观察场景。所有 REQ 条目只在需求文档中声明，放在对应业务规则附近。输入已含可用的 Requirement / Scenario 时，保留其已确认规则与场景，补齐规则已有依据的可观察边界。归档模板中的 TBD Purpose 应改为明确业务目标。
产品规格按可独立复核的业务结果拆分任务，写出作用对象、关键条件和可观察的交付结果，并引用需求 ID。技能使用记录放入审查意见或执行记录。每个任务独立占一行，格式为“- TASK-大写英文或数字标识: 任务及预期交付结果 | 需求: REQ-标识, REQ-标识”。任务 ID 唯一，每项需求至少被一个任务覆盖。产品任务不给出实现文件或技术选型，不复制需求正文。输出不要用代码围栏包裹。`;

/** 使用未经缩写的迭代标识归集文档，避免不同需求路径因分支名归一化而重合。 */
export function productPaths(iterationId: string) {
  const directory = `product/${assetIdSchema.parse(iterationId)}`;
  return { requirements: `${directory}/requirements.md`, specification: `${directory}/product-spec.md` };
}

/** 从同一审批正文拆出两份文件，先校验任务和需求的对应关系。 */
export function readProductDocuments(content: string) {
  const lines = content.split(/\r?\n/);
  const headings: { title: string; line: number }[] = [];
  const bodyLines: { line: string; index: number }[] = [];
  let fence: string | undefined;
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1]!.startsWith(fence) && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (fence) continue;
    bodyLines.push({ line, index });
    if (/^ {0,3}#\s/.test(line)) headings.push({ title: line.trim(), line: index });
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
  for (const { line, index } of bodyLines) {
    if (index <= specificationHeading.line) continue;
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

/** 拒绝误入正式双文档的内部制作痕迹；业务发布依赖仍可在正式规则中表达。 */
export function validateProductDraftPresentation(content: string) {
  const prohibited = [
    /\bmaterial-\d+-[a-f0-9]+\b/i,
    /(?:已读取|未读取).{0,24}(?:材料|正文|offset|分片)/,
    /\bskill_read\b|\bproduct-pm-[a-z0-9-]+\b/i,
    /^(?:#{1,6}\s*)?(?:执行记录|需求覆盖检查|制作过程|方法使用记录)\s*$/m,
    /(?:本稿依据|本稿基于).{0,36}(?:已读取|材料|Skill|工具)/,
  ];
  if (prohibited.some(pattern => pattern.test(content))) throw new Error('待审产品稿包含内部制作过程内容，须在写作阶段移出正式双文档');
}
