/** 仓库目标的底层纯契约，不依赖项目注册表或同步策略。 */
import { z } from 'zod';

export const remoteSyncTargetSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), label: z.string().trim().min(1).max(80), root: z.string().min(1), origin: z.string().url().refine(/** 拒绝携带用户名或密码的远端地址。 */value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }, '远端地址必须为不含凭据的 HTTPS URL') }).strict();
export type RemoteSyncTarget = z.infer<typeof remoteSyncTargetSchema>;
