/** Strategy：纯函数分片，与来源、Agent及Workflow解耦；保留原文位置，不生成业务摘要。 */
import { z } from 'zod';
import { materialPolicy } from '../../config/material-policy.js';
export const chunkPolicySchema = z.object({ strategy: z.enum(['paragraph', 'fixed']), chars: z.number().int().min(2).max(6000), pageSize: z.number().int().min(1).max(30), previewChars: z.number().int().min(0).max(160), responseBytes: z.number().int().min(1000).max(24000) }).strict();
export type ChunkPolicy = z.infer<typeof chunkPolicySchema>;
/** 每项为原文UTF-16半开区间，不能据预览声称已读取正文。 */
export interface MaterialChunk { offset: number; end: number; bytes: number; preview: string }
export const defaultChunkPolicy = Object.freeze(chunkPolicySchema.parse(materialPolicy.chunks));
/** 单次线性扫描；优先换行边界，超长行固定切片，避免切断Unicode代理对。 */
export function splitMaterial(text: string, config: ChunkPolicy = defaultChunkPolicy): MaterialChunk[] {
  const policy = chunkPolicySchema.parse(config); const result: MaterialChunk[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + policy.chars, text.length);
    if (policy.strategy === 'paragraph' && end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= offset + Math.floor(policy.chars / 2)) end = newline + 1;
    }
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    const content = text.slice(offset, end);
    result.push({ offset, end, bytes: Buffer.byteLength(content), preview: content.slice(0, policy.previewChars) });
    offset = end;
  }
  return result;
}
