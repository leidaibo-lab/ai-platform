import { teamSettingsSchema, writeTeamSettings } from '../mastra/team-settings.js';
import { teamConfigurationView } from './team-configuration-view.js';
import { createWorkbenchAccount } from './workbench-account.js';
import { readCandidateChanges } from './candidate-changes.js';
import { assertProjectCorrelation, loadEngineeringProject, projectRepositoryRoot, registeredProjects, selectProjectConfig, snapshotProjectConfig } from '../business-engineering/project.js';
import { autonomyPolicySchema } from '../development/v2/contracts.js';
import { adapterDeliveryRoots, assertDeliveryContractMatchesAdapter, defaultContractForAdapter, projectDeliveryContractSchema, readProjectDeliveryContract, writeProjectDeliveryContract } from '../business-engineering/delivery-contract.js';
/** HTTP Adapter 仅转换业务请求；本地互斥不承担跨实例协调。 */
import type { PracticeConfig } from '../mastra/config.js';
import { registerApiRoute, type ContextWithMastra } from '@mastra/core/server';
import { assembleRepositoryProject } from './repository-project.js';
import { readRepositoryCatalog } from './repository-catalog.js';
import { z } from 'zod';
import { assetIdSchema } from '../delivery/asset-identity.js';
import type { IntakeWorkflow } from './service.js';
import { correctIntake, GateInputError, readIntake, recoverStaleProductWriting, respondIntake } from './service.js';
import { projectLiveOutputFrame, projectWorkflowActivity } from './run-timeline.js';
import { intakeModeSchema } from './contracts.js';
import { deliverySchema } from '../mastra/workflows/delivery.js';
import { buildSuccessorBaseline, successorSource } from './successor-run.js';
import { readRemoteSyncSettings, readRemoteSyncTargets, remoteSyncSettingsSchema, remoteSyncTargets, targetDictionarySchema, writeRemoteSyncSettings, writeRemoteSyncTargets } from '../delivery/remote-sync-settings.js';
import type { WorkflowStreamEvent } from '@mastra/core/workflows';
import { prepareRunMigration } from './run-migration.js';
const startSchema = z.object({ projectId: z.string().optional(), runId: z.string().uuid(), brief: z.string().trim().min(1).max(12000), iterationId: assetIdSchema.default('unassigned'), intakeMode: intakeModeSchema.default('clarify') }).strict();
const successorRequestSchema = z.object({ runId: z.string().uuid(), artifactKinds: z.array(z.enum(['product', 'development', 'testing'])).min(1).max(3), changeBrief: z.string().trim().min(1).max(12000), iterationId: assetIdSchema.optional(), intakeMode: intakeModeSchema.default('clarify') });
/** 注册与 Studio 相同实例的主 Workflow，避免新旧业务入口脱节。 */
export function createIntakeRoutes(workflow: IntakeWorkflow, mode: 'fixture' | 'live', repositoryRoot?: string, config?: PracticeConfig) {
  const account = createWorkbenchAccount(config?.databaseUrl ?? 'file::memory:');
  const busy = new Set<string>();
  /** 新项目的 Run 只使用启动时登记的 Git 版本。 */
  function engineering(selected = config) { return selected?.engineeringProject ? loadEngineeringProject(selected.engineeringProject) : undefined; }
  /** 项目恢复、后继创建和纠偏统一核对原生初始化关联。 */
  async function verifyRunProject(runId: string) {
    if (!config) return;
    const source = await workflow.getWorkflowRunById(runId);
    try { return snapshotProjectConfig(config, source); }
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
    registerApiRoute('/intake-api/runs/:runId/migration', { method: 'GET',
      /** 迁移计划仅由原生状态及已有候选准备，不消耗模型调用。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try { return c.json((await prepareRunMigration(workflow, config!, c.req.param('runId'))).plan); }
        catch { return c.json({ error: '当前 Run 无法准备迁移，请核对历史身份、产品批准和候选检查点。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/runs/:runId/migration', { method: 'POST',
      /** 账号确认当前计划后创建新 Run，重复请求只对账相同目标谱系。 */
      handler: async c => {
        let id: string | undefined; let acquired = false;
        try {
          origin(c);
          const reviewer = account.current(c);
          if (!reviewer) return c.json({ error: '请登录后确认迁移。' }, 401);
          const request = z.object({ runId: z.uuid(), planHash: z.string().length(64) }).strict().parse(await c.req.json());
          id = request.runId;
          const sourceRunId = z.uuid().parse(c.req.param('runId'));
          if (id === sourceRunId || busy.has(id)) throw new Error('迁移目标不可用');
          busy.add(id); acquired = true;
          const existing = await workflow.getWorkflowRunById(id);
          if (existing) {
            const initial = existing.steps?.['initialize-product-development'];
            const migration = initial && !Array.isArray(initial) ? deliverySchema.safeParse(initial.output).data?.migration : undefined;
            if (migration?.sourceRunId !== sourceRunId || migration.planHash !== request.planHash) throw new Error('迁移目标归属不一致');
          } else {
            const { plan, product } = await prepareRunMigration(workflow, config!, sourceRunId);
            if (plan.hash !== request.planHash) throw new Error('迁移计划已变化');
            const run = await workflow.createRun({ runId: id });
            await run.start({ inputData: { projectId: plan.projectId, iterationId: plan.iterationId, brief: product.brief, intakeMode: 'clarify', migration: { sourceRunId, planHash: plan.hash, reviewer } } });
          }
          return c.json(await readIntake(workflow, id, config));
        } catch (error) { return failure(c, error); }
        finally { if (id && acquired) busy.delete(id); }
      },
    }),
    registerApiRoute('/intake-api/team-configuration', { method: 'GET',
      /** 只向已登录工作台返回白名单配置。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        if (!account.current(c)) return c.json({ error: '请先登录工作台。' }, 401);
        try { return c.json(teamConfigurationView(config!)); }
        catch { return c.json({ error: '团队配置暂不可读取，请检查服务端配置。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/team-configuration', { method: 'PUT',
      /** 保存前核对本机来源、会话和完整的白名单设置。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try {
          if (c.req.header('origin') !== 'http://127.0.0.1:4112') return c.json({ error: '请从本机工作台提交。' }, 403);
          if (!account.current(c)) return c.json({ error: '请先登录工作台。' }, 401);
          const input = teamSettingsSchema.parse(await c.req.json());
          writeTeamSettings(config!, input);
          return c.json(teamConfigurationView(config!));
        } catch { return c.json({ error: '团队配置未保存，请检查来源、输入范围和数据目录。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/projects', { method: 'GET',
      /** 客户端只取得服务端登记的项目 ID 和显示名称。 */
      handler: async c => c.json({ projects: config?.engineeringProjects ? registeredProjects(config).map(project => ({ id: project.id, title: project.label })) : [{ id: config?.engineeringProject?.id ?? 'hrm', title: config?.engineeringProject?.label ?? 'HRM 项目仓库' }] }),
    }),
    registerApiRoute('/intake-api/project-delivery-contract', { method: 'GET',
      /** 返回已登记项目身份、绑定仓库和当前落点契约，不接受客户端仓库地址。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try {
          const selected = selectProjectConfig(config!, c.req.query('projectId'));
          const project = selected.engineeringProject;
          if (!project) throw new Error('必须选择已登记项目');
          const candidate = loadEngineeringProject(project).candidate;
          const current = readProjectDeliveryContract(selected, undefined, defaultContractForAdapter(candidate));
          assertDeliveryContractMatchesAdapter(current.contract, candidate);
          return c.json({ project: { id: project.id, label: project.label, repositoryUrl: project.origin }, adapterRoots: adapterDeliveryRoots(candidate), contract: current.contract, hash: current.hash });
        } catch { return c.json({ error: '项目交付配置暂不可读取，请选择已登记业务工程。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/project-delivery-contract', { method: 'PUT',
      /** 仅本机页面可更新项目落点；项目仓库身份仍由服务端注册表解析。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try {
          origin(c);
          const selected = selectProjectConfig(config!, c.req.query('projectId'));
          if (!selected.engineeringProject) throw new Error('必须选择已登记项目');
          const contract = projectDeliveryContractSchema.parse(await c.req.json());
          const candidate = loadEngineeringProject(selected.engineeringProject).candidate;
          assertDeliveryContractMatchesAdapter(contract, candidate);
          const saved = writeProjectDeliveryContract(selected, contract);
          return c.json({ project: { id: selected.engineeringProject.id, label: selected.engineeringProject.label, repositoryUrl: selected.engineeringProject.origin }, adapterRoots: adapterDeliveryRoots(candidate), ...saved });
        } catch (error) { return c.json({ error: error instanceof z.ZodError ? '落点配置不符合要求，请检查安全相对路径和迭代变量。' : error instanceof Error ? error.message : '项目交付配置未保存。' }, 409); }
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
      /** 只公开项目身份、目标标签和受控远端地址，不返回本地路径。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try { const selected = selectProjectConfig(config!, c.req.query('projectId')); const targets = remoteSyncTargets(selected).filter(target => !selected.engineeringProject || target.id === selected.engineeringProject.id).map(/** 页面显示受控远端地址，不泄露本地checkout路径。 */target => ({ id: target.id, label: target.label, repositoryUrl: target.origin })); return c.json({ settings: readRemoteSyncSettings(selected), routingMode: selected.projectRegistrySelection ? 'project-bound' : 'phase-targets', project: selected.engineeringProject ? { id: selected.engineeringProject.id, label: selected.engineeringProject.label } : undefined, targets }); }
        catch { return c.json({ error: '远端同步设置暂不可读取，请检查服务端已授权仓库。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/remote-sync-settings', { method: 'PUT',
      /** 设置仅影响后续节点；仓库白名单仍由服务端配置拥有。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try { origin(c); const selected = selectProjectConfig(config!, c.req.query('projectId')); const targets = remoteSyncTargets(selected).filter(target => !selected.engineeringProject || target.id === selected.engineeringProject.id).map(/** 保存后仍只回传受控远端地址。 */target => ({ id: target.id, label: target.label, repositoryUrl: target.origin })); return c.json({ settings: writeRemoteSyncSettings(selected, remoteSyncSettingsSchema.parse(await c.req.json())), routingMode: selected.projectRegistrySelection ? 'project-bound' : 'phase-targets', project: selected.engineeringProject ? { id: selected.engineeringProject.id, label: selected.engineeringProject.label } : undefined, targets }); }
        catch (error) { return c.json({ error: error instanceof z.ZodError ? '设置格式不正确，请检查每个阶段的同步开关和仓库选择。' : error instanceof Error ? error.message : '远端同步设置未保存。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/project', { method: 'GET',
      // 只读固定配置仓库，不允许客户端切换宿主路径或读取文件内容。
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try {
          const selected = config ? c.req.query('runId') ? await verifyRunProject(c.req.query('runId')!) : selectProjectConfig(config, c.req.query('projectId')) : undefined;
          if (selected && c.req.query('projectId') && c.req.query('projectId') !== (selected.engineeringProject?.id ?? 'hrm')) throw new Error('查询项目与 Run 不一致');
          return c.json(engineering(selected)?.catalog ?? readRepositoryCatalog((selected && projectRepositoryRoot(selected)) ?? repositoryRoot));
        }
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
          if (config) selectProjectConfig(config, input.projectId);
          if (busy.has(id)) throw new Error('处理中'); busy.add(id); acquired = true;
          if (await workflow.getWorkflowRunById(id)) {
            await verifyRunProject(id);
            const existing = await readIntake(workflow, id, config);
            if (input.projectId && existing.projectId !== input.projectId) throw new Error('同一标识不能更换项目');
            if (existing.brief !== input.brief) throw new Error('同一标识不能更换需求');
            if (existing.intakeMode && existing.intakeMode !== input.intakeMode) throw new Error('同一标识不能更换需求处理方式');
            return c.json(existing);
          }
          const run = await workflow.createRun({ runId: id });
          await run.start({ inputData: { projectId: input.projectId, brief: input.brief, iterationId: input.iterationId, intakeMode: input.intakeMode, guidedIntake: input.intakeMode === 'clarify' } });
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
          const sourceRunId = z.string().uuid().parse(c.req.param('sourceRunId'));
          const request = successorRequestSchema.parse(await c.req.json()); id = request.runId;
          if (id === sourceRunId) throw new Error('后继 Run 必须使用新的 Run 标识');
          if (busy.has(id)) throw new Error('处理中'); busy.add(id); acquired = true;
          if (await workflow.getWorkflowRunById(id)) throw new Error('该 Run 标识已经存在');
          const source = await workflow.getWorkflowRunById(sourceRunId);
          if (!source || source.status !== 'success') throw new Error('只能基于已结束 Run 创建后继 Run');
          const product = source.steps?.['product-team'];
          const delivery = successorSource(source.result, product && !Array.isArray(product) ? product.output : undefined);
          const selected = config && selectProjectConfig(config, delivery?.correlation?.projectId);
          const root = selected && projectRepositoryRoot(selected);
          if (!root) throw new Error('后继 Run 缺少受控项目仓库');
          if (selected) assertProjectCorrelation(selected, delivery?.correlation, { allowEarlierRevision: true });
          if (!delivery?.correlation || !delivery.formalSpecifications?.length) throw new Error('来源 Run 不包含已确认并推送的正式规格');
          const baseline = buildSuccessorBaseline(root, sourceRunId, delivery, request.artifactKinds, request.changeBrief);
          const run = await workflow.createRun({ runId: id });
          await run.start({ inputData: { projectId: delivery.correlation.projectId, brief: request.changeBrief, iterationId: request.iterationId ?? delivery.correlation.iterationId, intakeMode: request.intakeMode, guidedIntake: request.intakeMode === 'clarify', successorBaseline: baseline } });
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
          for (const run of result.runs) {
            try { runs.push(await readIntake(workflow, run.runId, config)); }
            catch { runs.push({ runId: run.runId, status: 'unavailable', brief: '', unavailable: true }); }
          }
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
    registerApiRoute('/intake-api/runs/:runId/recover-stale-product-writing', { method: 'POST',
      /** 仅登录账号可接管超时遗留的产品写作；服务端复核步骤和时限。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        const id = c.req.param('runId'); let acquired = false;
        try {
          origin(c);
          if (!account.current(c)) return c.json({ error: '请登录后恢复写作。' }, 401);
          if (busy.has(id)) throw new Error('处理中'); busy.add(id); acquired = true;
          const selected = await verifyRunProject(id);
          return c.json(await recoverStaleProductWriting(workflow, mode, id, selected));
        } catch (error) { return failure(c, error); }
        finally { if (acquired) busy.delete(id); }
      },
    }),
    registerApiRoute('/intake-api/runs/:runId/events', { method: 'GET',
      // 复用 Mastra 原生 Workflow.watch；活动摘要只做即时提示，详情仍由快照接口权威返回。
      handler: async c => {
        const runId = c.req.param('runId');
        const encoder = new TextEncoder();
        let closed = false;
        let unwatch: (() => void | Promise<void>) | undefined;
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
              void unwatch?.();
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
            const run = await workflow.createRun({ runId });
            c.req.raw.signal.addEventListener('abort', close, { once: true });
            if (c.req.raw.signal.aborted) { close(); return; }
            const unsubscribe = await run.watchAsync(observe);
            if (closed) { void unsubscribe(); return; }
            unwatch = unsubscribe;
            send({ type: 'ready', runId, occurredAt: new Date().toISOString() });
          },
          cancel() {
            closed = true;
            if (finishTimer) clearTimeout(finishTimer);
            void unwatch?.();
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
          origin(c);
          const actor = account.current(c);
          if (!actor) return c.json({ error: '请登录后提交决定。' }, 401);
          if (busy.has(id)) throw new Error('处理中'); busy.add(id); acquired = true;
          const selected = await verifyRunProject(id);
          let input = await c.req.json();
          // 所有人工决定均由短期会话盖章；客户端旧字段不可伪造审阅人。
          input = { ...input, reviewer: actor, data: input.data ? { ...input.data, reviewer: actor, ...('operator' in input.data ? { operator: actor } : {}) } : input.data };
          if (selected?.engineeringProject && input.data?.project) throw new GateInputError('业务工程范围必须通过当前项目目录确认');
          if (input.data?.project?.executionProfile && !input.repositoryScope) throw new GateInputError('全栈项目必须通过已关联仓库确认，不能从页面传入源码或执行档');
          if (input.repositoryScope) {
            const selection = z.object({ catalogHash: z.string().length(64), maxReworks: z.number().int().min(0).max(3).optional(), autonomy: autonomyPolicySchema.optional(), comment: z.string().trim().min(1).max(2000) }).parse(input.repositoryScope);
            let project;
            try {
              const registered = engineering(selected);
              if (registered && registered.catalog.catalogHash !== selection.catalogHash) throw new Error('项目目录版本已变化，请刷新后重新确认');
              project = registered?.candidate ?? assembleRepositoryProject((selected && projectRepositoryRoot(selected)) ?? repositoryRoot, selection.catalogHash);
            }
            catch (error) { throw new GateInputError(error instanceof Error ? error.message : '仓库配置不可用'); }
            input = { gateHash: input.gateHash, data: { project, reviewer: actor, comment: selection.comment, maxReworks: selection.maxReworks ?? 1, autonomy: selection.autonomy } };
          }
          return c.json(await respondIntake(workflow, mode, id, input, config));
        } catch (error) { return failure(c, error); }
        finally { if (acquired) busy.delete(id); }
      },
    }),
  ];
}
