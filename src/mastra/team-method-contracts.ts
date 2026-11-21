/** 全团队方法契约只描述资源和绑定，不包含工具、权限或运行事实。 */
import { z } from 'zod';

export const methodRefSchema = z.object({ name: z.string().regex(/^[a-z0-9-]+$/).max(200), version: z.string().trim().min(1).max(100) }).strict();
export const methodResourceSchema = methodRefSchema.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/), content: z.string().min(1).max(1024 * 1024) });
export const methodSkillSchema = methodResourceSchema.extend({ references: z.record(z.string(), z.string().max(1024 * 1024)) });
export const methodBindingsSchema = z.object({ prompts: z.record(z.string().regex(/^[a-z][a-z0-9.-]+$/), methodRefSchema), skills: z.record(z.enum(['context', 'task', 'readiness', 'architectureDocument', 'review', 'browser']), methodRefSchema) }).strict();
export const teamMethodsSchema = z.object({ schemaVersion: z.literal('nacos-team-methods.v1'), source: z.url(), namespace: z.string().min(1), prompts: z.record(z.string(), methodResourceSchema), skills: z.record(z.string(), methodSkillSchema), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type TeamMethods = z.infer<typeof teamMethodsSchema>;
export type MethodBindings = z.infer<typeof methodBindingsSchema>;
