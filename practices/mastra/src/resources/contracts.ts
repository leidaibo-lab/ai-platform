/** Run只保存原生版本引用和摘要；内容与版本生命周期属于Mastra Store。 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const resourceWorkflowId = 'product-development-resources-v1';
export const freezeStepId = 'freeze-role-resources';
/** 负责人和子成员使用独立资源身份，自主能力不向普通模板扩散。 */
export function developmentResourceKey(role: string, autonomy: boolean, parent: boolean) { return `development-${role}-${autonomy ? 'autonomous' : 'standard'}-${parent ? 'owner' : 'member'}`; }
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const frozenResourcesSchema = z.object({
  version: z.literal('role-resources.v2'), runId: z.string().min(1), mode: z.enum(['fixture', 'live']), configHash: hash, bundleHash: hash,
  runtimeConfig: z.unknown(),
  sourceSnapshotHash: hash,
  artifact: z.object({ digest: hash, assurance: z.enum(['fixture', 'signed']), signer: z.string() }).strict(),
  endpointHash: hash,
  roles: z.record(z.string(), z.object({ agentId: z.string(), versionId: z.string(), configHash: hash, toolContractHash: hash }).strict()),
}).strict();
export type FrozenResources = z.infer<typeof frozenResourcesSchema>;

/** 只公开固定错误码，不将资源正文、路径或凭据写入Workflow错误。 */
export class ResourceError extends Error {
  /** 标识失败的资源边界。 */
  constructor(public readonly code: string) { super(`ROLE_RESOURCE_${code}`); this.name = 'ResourceError'; }
}

/** 对普通JSON递归排序；保留数组语义，拒绝不可序列化值。 */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(/** 键排序不改变数组和工具参数顺序。 */key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  throw new ResourceError('INVALID_JSON');
}
/** 计算原始字节摘要。 */
export function bytesHash(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
/** 计算结构化资源摘要。 */
export function resourceHash(value: unknown) { return bytesHash(canonical(value)); }
/** 凭据不进入身份；拒绝把凭据放在URL中。 */
export function endpointHash(baseUrl?: string) {
  const url = new URL(baseUrl ?? 'https://api.openai.com/v1');
  if (url.username || url.password || url.search || url.hash) throw new ResourceError('ENDPOINT_INVALID');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return bytesHash(url.toString());
}
