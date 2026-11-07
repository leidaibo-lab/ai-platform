/** HTTP Adapter 仅转换业务请求；本地互斥不承担跨实例协调。 */
import { registerApiRoute, type ContextWithMastra } from '@mastra/core/server';
import { z } from 'zod';
import { assetIdSchema } from '../delivery/asset-identity.js';
import type { IntakeWorkflow } from './service.js';
import { GateInputError, readIntake, respondIntake } from './service.js';
const startSchema = z.object({ runId: z.string().uuid(), brief: z.string().trim().min(1).max(12000), iterationId: assetIdSchema.default('unassigned') });
/** 注册与 Studio 相同实例的主 Workflow，避免新旧业务入口脱节。 */
export function createIntakeRoutes(workflow: IntakeWorkflow, mode: 'fixture' | 'live') {
  const busy = new Set<string>();
  /** 校验本机写来源；标签不等于认证身份。 */
  function origin(c: ContextWithMastra) {
    const value = c.req.header('origin');
    if (value && ![new URL(c.req.url).origin, 'http://127.0.0.1:4112'].includes(value)) throw new Error('请从本机页面提交');
  }
  /** 不返回模型响应、业务输入或内部堆栈。 */
  function failure(c: ContextWithMastra, error: unknown) {
    return c.json({ error: error instanceof GateInputError ? error.message : error instanceof z.ZodError ? '有内容未填完整或不符合要求，请检查必填、文件范围和列表中的每一项' : '操作未完成，请刷新确认版本、必答项及流程状态；不要自动重试批准。' }, 409);
  }
  return [
    registerApiRoute('/intake-api/runs', { method: 'POST',
      // 客户端预先固定 Run ID，响应丢失可回读，禁止重复创建。
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        let id: string | undefined; let acquired = false;
        try {
          origin(c); const input = startSchema.parse(await c.req.json()); id = input.runId;
          if (busy.has(id)) throw new Error('处理中'); busy.add(id); acquired = true;
          if (await workflow.getWorkflowRunById(id)) {
            const existing = await readIntake(workflow, id);
            if (existing.brief !== input.brief) throw new Error('同一标识不能更换需求');
            return c.json(existing);
          }
          const run = await workflow.createRun({ runId: id });
          await run.start({ inputData: { brief: input.brief, iterationId: input.iterationId, guidedIntake: true } });
          return c.json(await readIntake(workflow, id));
        } catch (error) { return failure(c, error); }
        finally { if (id && acquired) busy.delete(id); }
      },
    }),
    registerApiRoute('/intake-api/runs', { method: 'GET',
      // 列表只投影主流程摘要，限制读取数量。
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try {
          const result = await workflow.listWorkflowRuns({ page: 0, perPage: 30 });
          const runs = [];
          for (const run of result.runs) runs.push(await readIntake(workflow, run.runId));
          return c.json({ runs });
        } catch (error) { return failure(c, error); }
      },
    }),
    registerApiRoute('/intake-api/runs/:runId', { method: 'GET',
      // 每次刷新以原生快照为准。
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try { return c.json(await readIntake(workflow, c.req.param('runId'))); }
        catch (error) { return failure(c, error); }
      },
    }),
    registerApiRoute('/intake-api/runs/:runId/respond', { method: 'POST',
      // 写锁覆盖校验与恢复；失败保留浏览器输入，由用户主动回读。
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        const id = c.req.param('runId'); let acquired = false;
        try {
          origin(c); if (busy.has(id)) throw new Error('处理中'); busy.add(id); acquired = true;
          return c.json(await respondIntake(workflow, mode, id, await c.req.json()));
        } catch (error) { return failure(c, error); }
        finally { if (acquired) busy.delete(id); }
      },
    }),
  ];
}
