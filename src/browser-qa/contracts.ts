/** 批准用例与宿主证据；不允许模型输入任意URL或脚本。 */
import { z } from 'zod';
import { safePathSchema } from '../development/contracts.js';
export const browserCaseSchema = z.object({ entry: safePathSchema, assets: z.array(safePathSchema).max(30), actions: z.array(z.object({ action: z.enum(['click', 'fill']), selector: z.string().min(1).max(300), value: z.string().max(1000) })).max(12), assertions: z.array(z.object({ selector: z.string().min(1).max(300), text: z.string().min(1).max(1000) })).min(1).max(12) }).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const browserReceiptSchema = z.object({ version: z.literal('browser-receipt.v1'), caseId: z.string(), caseHash: hash, sourceHash: hash, methodHash: hash, status: z.enum(['passed', 'failed', 'blocked']), reason: z.string(), startedAt: z.iso.datetime(), durationMs: z.number().nonnegative(), steps: z.array(z.object({ action: z.string(), selector: z.string(), observed: z.string() })), consoleErrors: z.array(z.string()), blockedRequests: z.number().int().nonnegative(), screenshot: z.object({ base64: z.string().max(1500000), sha256: hash }).nullable() });
export type BrowserCase = z.infer<typeof browserCaseSchema>;
export type BrowserReceipt = z.infer<typeof browserReceiptSchema>;
/** 文件只来自同版本候选快照；supported由宿主执行档决定。 */
export interface BrowserRequest { caseId: string; caseHash: string; sourceHash: string; methodHash: string; browser: BrowserCase; files: Record<string, string>; supported: boolean; }
