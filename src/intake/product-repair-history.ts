import { z } from 'zod';

const diagnostic = /^(?:产品稿须包含 1 至 100 项带 REQ-ID 和验收预期的需求|第 \d+ 行的可验收需求格式无效|可验收需求 ID 重复：REQ-[A-Z0-9-]+|待审稿须依次包含「# 需求文档」和「# 产品规格」两份正文|需求条目必须声明在需求文档中|产品任务格式无效或 ID 重复|产品任务 TASK-[A-Z0-9-]+ 的需求引用未知或重复|产品任务须覆盖需求文档中的全部需求 ID|待审产品稿包含内部制作过程内容：第\d+行存在(?:内部材料标识|材料读取过程|内部方法或工具名称|内部执行记录|内部制作依据))$/;
const historySchema = z.array(z.object({
  candidateHash: z.string().regex(/^[a-f0-9]{64}$/),
  finding: z.string().regex(diagnostic),
  outcome: z.enum(['rework', 'no-progress', 'budget-exhausted']),
})).min(1).max(4);
const outcomes = { rework: '进入修订', 'no-progress': '候选重复，停止修订', 'budget-exhausted': '修订预算耗尽' };

/** 仅从原生失败快照投影已知诊断，非法字段整组拒绝展示。 */
export function productRepairDetails(error: unknown): string[] {
  if (!error || typeof error !== 'object') return [];
  const parsed = historySchema.safeParse((error as { productRepairHistory?: unknown }).productRepairHistory);
  if (!parsed.success) return [];
  return parsed.data.map((item, index) => `第${index + 1}轮校验，候选 ${item.candidateHash.slice(0, 12)}，${item.finding}，${outcomes[item.outcome]}。`);
}
