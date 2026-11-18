import { developmentHash } from '../contracts.js';

/** 按段落与标题组织原文；单元只表示阅读范围，不推断需求或验收语义。 */
export function createProductUnits(content: string): { id: string; line: number; text: string; hash: string }[] {
  const lines = content.split('\n');
  const units: { id: string; line: number; text: string; hash: string }[] = [];
  let start = -1;
  let current: string[] = [];
  /** 按原始起始行生成稳定引用，正文和摘要均来自批准原文。 */
  function flush(): void {
    if (start < 0) return;
    const text = current.join('\n');
    units.push({ id: `product:L${start + 1}`, line: start + 1, text, hash: developmentHash(text) });
    start = -1;
    current = [];
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) { flush(); continue; }
    // 标题独立定位；长段只在行边界拆分，避免截断原文。
    if (current.length && (/^\s{0,3}#{1,6}\s/.test(line) || current.join('\n').length + line.length + 1 > 1800)) flush();
    if (start < 0) start = index;
    current.push(line);
  }
  flush();
  return units;
}
