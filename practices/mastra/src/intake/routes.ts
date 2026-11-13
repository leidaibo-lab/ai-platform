import { cancelExecution } from './execution-control.js';
import { autonomyPolicySchema } from '../development/v2/contracts.js';
/** HTTP Adapter 仅转换业务请求；本地互斥不承担跨实例协调。 */
import type { PracticeConfig } from '../mastra/config.js';
import { registerApiRoute, type ContextWithMastra } from '@mastra/core/server';
import { assembleRepositoryProject } from './repository-project.js';
import { readRepositoryCatalog } from './repository-catalog.js';
import { z } from 'zod';
import { assetIdSchema } from '../delivery/asset-identity.js';
import type { IntakeWorkflow } from './service.js';
import { GateInputError, readIntake, respondIntake } from './service.js';
import { readRemoteSyncSettings, readRemoteSyncTargets, remoteSyncSettingsSchema, remoteSyncTargets, targetDictionarySchema, writeRemoteSyncSettings, writeRemoteSyncTargets } from '../delivery/remote-sync-settings.js';
import type { RoleAgents } from '../resources/catalog.js';
import { listRoleWorkbench, publishRoleWorkbench } from '../resources/workbench.js';
import { ResourceError } from '../resources/contracts.js';
const startSchema = z.object({ runId: z.string().uuid(), brief: z.string().trim().min(1).max(12000), iterationId: assetIdSchema.default('unassigned') });
/** 注册与 Studio 相同实例的主 Workflow，避免新旧业务入口脱节。 */
export function createIntakeRoutes(workflow: IntakeWorkflow, mode: 'fixture' | 'live', repositoryRoot?: string, config?: PracticeConfig, agents?: RoleAgents) {
  const busy = new Set<string>();
  /** 校验本机写来源；标签不等于认证身份。 */
  function origin(c: ContextWithMastra) {
    const value = c.req.header('origin');
    if (value && ![new URL(c.req.url).origin, 'http://127.0.0.1:4112'].includes(value)) throw new Error('请从本机页面提交');
  }
  /** 不返回模型响应、业务输入或内部堆栈。 */
  function failure(c: ContextWithMastra, error: unknown) {
    const message = error instanceof ResourceError && error.code === 'ARTIFACT_DRIFT'
      ? '当前运行版本与可信制品不一致，请重新发布或启动新 Run。旧 Run 已保留，不能直接用新代码恢复。'
      : error instanceof GateInputError ? error.message
        : error instanceof z.ZodError ? '有内容未填完整或不符合要求，请检查必填、文件范围和列表中的每一项'
          : '操作未完成，请刷新确认版本、必答项及流程状态；不要自动重试批准。';
    return c.json({ error: message }, 409);
  }
  /** 工作台角色服务只使用本次HTTP上下文绑定的原生Store；没有完整宿主依赖时失败关闭。 */
  async function roleService(c: ContextWithMastra) {
    const storage = c.get('mastra')?.getStorage();
    if (!storage || !config || !agents) throw new ResourceError('STORE_UNAVAILABLE');
    return { storage, config, agents };
  }
  return [
    registerApiRoute('/intake-api/role-resources', { method: 'GET',
      /** 只返回可编辑角色版本投影，不导出Skill正文、实现字节或凭据。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try { const service = await roleService(c); return c.json(await listRoleWorkbench(service.storage, service.config, service.agents)); }
        catch { return c.json({ error: '角色资源暂不可读取，请检查本机服务与原生资源库。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/role-resources/publish', { method: 'POST',
      /** 发布只新建原生版本；现有Run在冻结版本下继续，页面不能改Run绑定。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try { origin(c); const service = await roleService(c); return c.json(await publishRoleWorkbench(service.storage, service.config, service.agents, await c.req.json())); }
        catch (error) { return c.json({ error: error instanceof z.ZodError ? '角色增强内容不符合受控字段约束。' : error instanceof ResourceError && error.code === 'VERSION_CONFLICT' ? '角色已发布新版本，请刷新后基于最新版本重新编辑。' : '角色版本未发布；请刷新后核对工具与当前版本。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/remote-sync-targets', { method: 'GET',
      /** 仓库字典页仅在本机展示已登记目标及其本地checkout，阶段页继续隐藏路径。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try { return c.json({ targets: readRemoteSyncTargets(config!) }); }
        catch (error) { return c.json({ error: error instanceof Error ? error.message : '项目仓库字典暂不可读取。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/remote-sync-targets', { method: 'PUT',
      /** 仅本机服务保存完整字典；服务端复核Git根目录和origin，不能通过页面输入凭据。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try { origin(c); return c.json({ targets: writeRemoteSyncTargets(config!, targetDictionarySchema.parse(await c.req.json())) }); }
        catch (error) { return c.json({ error: error instanceof z.ZodError ? '仓库字典格式不正确，请检查标识、名称、本地checkout和HTTPS远端地址。' : error instanceof Error ? error.message : '项目仓库字典未保存。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/remote-sync-settings', { method: 'GET',
      /** 只公开目标标签和阶段选择，绝不向浏览器返回本地路径或Git地址。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try { return c.json({ settings: readRemoteSyncSettings(config!), targets: remoteSyncTargets(config!).map(/** 页面显示受控远端地址，不泄露本地checkout路径。 */target => ({ id: target.id, label: target.label, repositoryUrl: target.origin })) }); }
        catch { return c.json({ error: '远端同步设置暂不可读取，请检查服务端已授权仓库。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/remote-sync-settings', { method: 'PUT',
      /** 设置仅影响后续节点；仓库白名单仍由服务端配置拥有。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try { origin(c); return c.json({ settings: writeRemoteSyncSettings(config!, remoteSyncSettingsSchema.parse(await c.req.json())), targets: remoteSyncTargets(config!).map(/** 保存后仍只回传受控远端地址。 */target => ({ id: target.id, label: target.label, repositoryUrl: target.origin })) }); }
        catch (error) { return c.json({ error: error instanceof z.ZodError ? '设置格式不正确，请检查每个阶段的同步开关和仓库选择。' : error instanceof Error ? error.message : '远端同步设置未保存。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/project', { method: 'GET',
      // 只读固定配置仓库，不允许客户端切换宿主路径或读取文件内容。
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try { return c.json(readRepositoryCatalog(repositoryRoot)); }
        catch { return c.json({ available: false, reason: '已关联仓库暂不可读，请检查仓库路径及授权。' }, 409); }
      },
    }),
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
    registerApiRoute('/intake-api/runs/:runId/cancel', { method: 'POST',
      // 不获取start/respond长锁，只能以当前执行token取消只读生成。
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try {
          origin(c); const id = z.string().uuid().parse(c.req.param('runId'));
          const { token } = z.object({ token: z.string().uuid() }).strict().parse(await c.req.json());
          await cancelExecution(id, token,
            // createRun复用同进程原生活动实例；不得伪造Store终态。
            async () => { const run = await workflow.createRun({ runId: id }); await run.cancel(); });
          return c.json(await readIntake(workflow, id));
        } catch { return c.json({ error: '取消未确认：执行已变化、已结束或不属于当前服务。请刷新状态；不要重新提交原操作。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/runs/:runId/respond', { method: 'POST',
      // 写锁覆盖校验与恢复；失败保留浏览器输入，由用户主动回读。
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        const id = c.req.param('runId'); let acquired = false;
        try {
          origin(c); if (busy.has(id)) throw new Error('处理中'); busy.add(id); acquired = true;
          let input = await c.req.json();
          if (input.data?.project?.executionProfile && !input.repositoryScope) throw new GateInputError('全栈项目必须通过已关联仓库确认，不能从页面传入源码或执行档');
          if (input.repositoryScope) {
            const selection = z.object({ catalogHash: z.string().length(64), maxReworks: z.number().int().min(0).max(3).optional(), autonomy: autonomyPolicySchema.optional(), reviewer: z.string().trim().min(1).max(100), comment: z.string().trim().min(1).max(2000) }).parse(input.repositoryScope);
            let project;
            try { project = assembleRepositoryProject(repositoryRoot, selection.catalogHash); }
            catch (error) { throw new GateInputError(error instanceof Error ? error.message : '仓库配置不可用'); }
            input = { gateHash: input.gateHash, data: { project, reviewer: selection.reviewer, comment: selection.comment, maxReworks: selection.maxReworks ?? 1, autonomy: selection.autonomy } };
          }
          return c.json(await respondIntake(workflow, mode, id, input, config));
        } catch (error) { return failure(c, error); }
        finally { if (acquired) busy.delete(id); }
      },
    }),
  ];
}
