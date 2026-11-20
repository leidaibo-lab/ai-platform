import { createWorkbenchAccount } from './workbench-account.js';
import { readCandidateChanges } from './candidate-changes.js';
import { assertProjectCorrelation, loadEngineeringProject, projectRepositoryRoot } from '../business-engineering/project.js';
import { autonomyPolicySchema } from '../development/v2/contracts.js';
/** HTTP Adapter 仅转换业务请求；本地互斥不承担跨实例协调。 */
import type { PracticeConfig } from '../mastra/config.js';
import { registerApiRoute, type ContextWithMastra } from '@mastra/core/server';
import { assembleRepositoryProject } from './repository-project.js';
import { readRepositoryCatalog } from './repository-catalog.js';
import { z } from 'zod';
import { assetIdSchema } from '../delivery/asset-identity.js';
import type { IntakeWorkflow } from './service.js';
import { correctIntake, GateInputError, readIntake, respondIntake } from './service.js';
import { projectLiveOutputFrame, projectWorkflowActivity } from './run-timeline.js';
import { intakeModeSchema } from './contracts.js';
import { deliverySchema } from '../mastra/workflows/delivery.js';
import { buildSuccessorBaseline, successorSource } from './successor-run.js';
import { readRemoteSyncSettings, readRemoteSyncTargets, remoteSyncSettingsSchema, remoteSyncTargets, targetDictionarySchema, writeRemoteSyncSettings, writeRemoteSyncTargets } from '../delivery/remote-sync-settings.js';
import type { WorkflowStreamEvent } from '@mastra/core/workflows';
const startSchema = z.object({ runId: z.string().uuid(), brief: z.string().trim().min(1).max(12000), iterationId: assetIdSchema.default('unassigned'), intakeMode: intakeModeSchema.default('clarify') });
const successorRequestSchema = z.object({ runId: z.string().uuid(), artifactKinds: z.array(z.enum(['product', 'development', 'testing'])).min(1).max(3), changeBrief: z.string().trim().min(1).max(12000), iterationId: assetIdSchema.optional(), intakeMode: intakeModeSchema.default('clarify') });
/** 注册与 Studio 相同实例的主 Workflow，避免新旧业务入口脱节。 */
export function createIntakeRoutes(workflow: IntakeWorkflow, mode: 'fixture' | 'live', repositoryRoot?: string, config?: PracticeConfig) {
  const account = createWorkbenchAccount(config?.databaseUrl ?? 'file::memory:');
  const busy = new Set<string>();
  /** 新项目的 Run 只使用启动时登记的 Git 版本。 */
  function engineering() { return config?.engineeringProject ? loadEngineeringProject(config.engineeringProject) : undefined; }
  /** 项目恢复、后继创建和纠偏统一核对原生初始化关联。 */
  async function verifyRunProject(runId: string) {
    if (!config) return;
    const source = await workflow.getWorkflowRunById(runId);
    const step = source?.steps?.['initialize-product-development'];
    const parsed = deliverySchema.safeParse(step && !Array.isArray(step) ? step.output : undefined);
    try { assertProjectCorrelation(config, parsed.data?.correlation); }
    catch { throw new GateInputError('当前 Run 需要使用创建时绑定的业务工程版本'); }
  }
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
    ...account.routes,
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
        try { return c.json(engineering()?.catalog ?? readRepositoryCatalog(repositoryRoot)); }
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
            await verifyRunProject(id);
            const existing = await readIntake(workflow, id, config);
            if (existing.brief !== input.brief) throw new Error('同一标识不能更换需求');
            if (existing.intakeMode && existing.intakeMode !== input.intakeMode) throw new Error('同一标识不能更换需求处理方式');
            return c.json(existing);
          }
          const run = await workflow.createRun({ runId: id });
          await run.start({ inputData: { brief: input.brief, iterationId: input.iterationId, intakeMode: input.intakeMode, guidedIntake: input.intakeMode === 'clarify' } });
          return c.json(await readIntake(workflow, id, config));
        } catch (error) { return failure(c, error); }
        finally { if (id && acquired) busy.delete(id); }
      },
    }),
    registerApiRoute('/intake-api/runs/:sourceRunId/successors', { method: 'POST',
      /** 后继 Run 只由服务端读取旧 Run 已确认规格；页面无法提供 branch、commit、仓库或正文。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        let id: string | undefined; let acquired = false;
        try {
          origin(c);
          const root = config && projectRepositoryRoot(config);
          if (!root) throw new Error('后继 Run 缺少受控项目仓库');
          const sourceRunId = z.string().uuid().parse(c.req.param('sourceRunId'));
          const request = successorRequestSchema.parse(await c.req.json()); id = request.runId;
          if (id === sourceRunId) throw new Error('后继 Run 必须使用新的 Run 标识');
          if (busy.has(id)) throw new Error('处理中'); busy.add(id); acquired = true;
          if (await workflow.getWorkflowRunById(id)) throw new Error('该 Run 标识已经存在');
          const source = await workflow.getWorkflowRunById(sourceRunId);
          if (!source || source.status !== 'success') throw new Error('只能基于已结束 Run 创建后继 Run');
          const product = source.steps?.['product-team'];
          const delivery = successorSource(source.result, product && !Array.isArray(product) ? product.output : undefined);
          if (config) assertProjectCorrelation(config, delivery?.correlation, { allowEarlierRevision: true });
          if (!delivery?.correlation || !delivery.formalSpecifications?.length) throw new Error('来源 Run 不包含已确认并推送的正式规格');
          const baseline = buildSuccessorBaseline(root, sourceRunId, delivery, request.artifactKinds, request.changeBrief);
          const run = await workflow.createRun({ runId: id });
          await run.start({ inputData: { brief: request.changeBrief, iterationId: request.iterationId ?? delivery.correlation.iterationId, intakeMode: request.intakeMode, guidedIntake: request.intakeMode === 'clarify', successorBaseline: baseline } });
          return c.json(await readIntake(workflow, id, config));
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
          for (const run of result.runs) runs.push(await readIntake(workflow, run.runId, config));
          return c.json({ runs });
        } catch (error) { return failure(c, error); }
      },
    }),
    registerApiRoute('/intake-api/runs/:runId', { method: 'GET',
      // 每次刷新以原生快照为准。
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try { return c.json(await readIntake(workflow, c.req.param('runId'), config)); }
        catch (error) { return failure(c, error); }
      },
    }),
    registerApiRoute('/intake-api/runs/:runId/candidate-changes', { method: 'GET',
      /** 按需投影已保存候选，避免把源码放入 Run 摘要。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try {
          if (!config) return c.json({ status: 'unavailable' });
          const runId = c.req.param('runId');
          await verifyRunProject(runId);
          return c.json(await readCandidateChanges(workflow, runId, config));
        } catch {
          return c.json({ status: 'unavailable' });
        }
      },
    }),
    registerApiRoute('/intake-api/runs/:runId/events', { method: 'GET',
      // 复用 Mastra 原生 Workflow.watch；活动摘要只做即时提示，详情仍由快照接口权威返回。
      handler: async c => {
        const runId = c.req.param('runId');
        const encoder = new TextEncoder();
        let closed = false;
        let unwatch: (() => void) | undefined;
        let finishTimer: ReturnType<typeof setTimeout> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            /** 发送一条受控 SSE 数据，不把 Workflow 原始 payload 传给浏览器。 */
            function send(payload: Record<string, unknown>) {
              if (closed) return;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            }
            /** 关闭订阅并释放 Mastra watch 观察者。 */
            function close() {
              if (closed) return;
              closed = true;
              if (finishTimer) clearTimeout(finishTimer);
              unwatch?.();
              controller.close();
            }
            /** 将原生 Workflow 事件压缩为可公开的节点变化摘要。 */
            function observe(event: WorkflowStreamEvent) {
              if (event.runId && event.runId !== runId) return;
              const liveOutput = projectLiveOutputFrame(event);
              const payload = 'payload' in event && event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
              const eventId = 'id' in event && typeof event.id === 'string' ? event.id : null;
              const stepId = eventId ?? (typeof payload.id === 'string' ? payload.id : null);
              if (liveOutput) { send({ type: 'live-output', runId, stepId: liveOutput.stepId ?? stepId, taskKey: liveOutput.taskKey, output: liveOutput.output }); return; }
              if (event.type === 'workflow-step-output') return;
              const status = typeof payload.status === 'string' ? payload.status : typeof payload.workflowStatus === 'string' ? payload.workflowStatus : null;
              const occurredAt = new Date().toISOString();
              send({ type: 'workflow-event', runId, eventType: event.type, stepId, status, occurredAt, activity: projectWorkflowActivity(event.type, stepId, status, occurredAt) });
              if (event.type === 'workflow-finish' || event.type === 'workflow-canceled') finishTimer = setTimeout(close, 100);
            }
            send({ type: 'ready', runId, occurredAt: new Date().toISOString() });
            const run = await workflow.createRun({ runId });
            unwatch = run.watch(observe);
            c.req.raw.signal.addEventListener('abort', close, { once: true });
          },
          cancel() {
            closed = true;
            if (finishTimer) clearTimeout(finishTimer);
            unwatch?.();
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } });
      },
    }),
    registerApiRoute('/intake-api/runs/:runId/correct-product', { method: 'POST',
      /** 运行中纠偏通过独立入口通知正在执行的模型步骤。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try {
          origin(c);
          const reviewer = account.current(c);
          if (!reviewer) return c.json({ error: '请登录后提交纠偏。' }, 401);
          const input = z.object({ attempt: z.uuid(), feedback: z.string().trim().min(1).max(2000).optional() }).strict().parse(await c.req.json());
          await verifyRunProject(c.req.param('runId'));
          return c.json(await correctIntake(workflow, mode, c.req.param('runId'), input.feedback ? { ...input, reviewer } : { attempt: input.attempt }, config));
        }
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
          await verifyRunProject(id);
          let input = await c.req.json();
          if (config?.engineeringProject && input.data?.project) throw new GateInputError('业务工程范围必须通过当前项目目录确认');
          if (input.data?.project?.executionProfile && !input.repositoryScope) throw new GateInputError('全栈项目必须通过已关联仓库确认，不能从页面传入源码或执行档');
          if (input.repositoryScope) {
            const selection = z.object({ catalogHash: z.string().length(64), maxReworks: z.number().int().min(0).max(3).optional(), autonomy: autonomyPolicySchema.optional(), reviewer: z.string().trim().min(1).max(100), comment: z.string().trim().min(1).max(2000) }).parse(input.repositoryScope);
            let project;
            try {
              const registered = engineering();
              if (registered && registered.catalog.catalogHash !== selection.catalogHash) throw new Error('项目目录版本已变化，请刷新后重新确认');
              project = registered?.candidate ?? assembleRepositoryProject(repositoryRoot, selection.catalogHash);
            }
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
