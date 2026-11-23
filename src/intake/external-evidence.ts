import { createHash } from 'node:crypto';
import { z } from 'zod';

/** 外部结果的最小来源回执，不含查询、正文或 URL 参数。 */
export const externalSourceSchema = z.object({ provider: z.literal('tavily'), kind: z.enum(['search', 'page']), url: z.url().max(2000), retrievedAt: z.iso.datetime(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), truncated: z.boolean().optional() });

/** 从已成功的原生工具结果提取来源；不将搜索摘要记作网页读取。 */
export function externalSourceReceipts(results: unknown): z.infer<typeof externalSourceSchema>[] {
  if (!Array.isArray(results)) return [];
  const receipts: z.infer<typeof externalSourceSchema>[] = [];
  /** 地址移除参数和片段，避免将访问令牌投影到 Run。 */
  function safeUrl(value: unknown): string | undefined {
    if (typeof value !== 'string') return;
    try { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) return; url.search = ''; url.hash = ''; return url.href.length <= 2000 ? url.href : undefined; } catch { return; }
  }
  for (const item of results) {
    const payload = item?.payload ?? item;
    if (!payload || payload.isError || !['external_search', 'external_search_search', 'external_read_page', 'external_readPage'].includes(payload.toolName)) continue;
    const result = payload.result;
    if (!result || result.provider !== 'tavily' || !z.iso.datetime().safeParse(result.retrievedAt).success) continue;
    if (Array.isArray(result.results)) {
      for (const entry of result.results.slice(0, 5)) {
        const url = safeUrl(entry?.url);
        if (url && typeof entry.excerpt === 'string') receipts.push({ provider: 'tavily', kind: 'search', url, retrievedAt: result.retrievedAt, contentHash: createHash('sha256').update(entry.excerpt).digest('hex') });
      }
    } else {
      const url = safeUrl(result.url);
      if (url && typeof result.contentHash === 'string' && /^[a-f0-9]{64}$/.test(result.contentHash) && typeof result.truncated === 'boolean') receipts.push({ provider: 'tavily', kind: 'page', url, retrievedAt: result.retrievedAt, contentHash: result.contentHash, truncated: result.truncated });
    }
  }
  return receipts.slice(0, 30);
}
