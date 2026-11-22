/** 独立团队 API 复用工作台身份、原生状态投影与现有人工关口校验。 */
import { registerApiRoute } from '@mastra/core/server';
import type { Mastra } from '@mastra/core';
import type { PracticeConfig } from '../mastra/config.js';
import { z } from 'zod';
import { createWorkbenchAccount } from './workbench-account.js';
import { readIntake, respondIntake, type IntakeWorkflow } from './service.js';
import { selectProjectConfig } from '../business-engineering/project.js';
import { loadEngineeringProject, snapshotProjectConfig } from '../business-engineering/project.js';
import { assembleRepositoryProject } from './repository-project.js';
import { resolveTeamSource, teamIds, teamRunInputSchema, teamWorkflowKeys, teamWorkflowIds } from '../team/runs.js';
import { businessWorkflowSchema } from '../delivery/asset-identity.js';
import { developmentHash } from '../development/contracts.js';
import { resolveInputPackage } from '../team/input-packages.js';
import { createPlatformRecoveryRoutes } from './platform-recovery.js';

/** 来源发现只返回可核验引用，非法或已漂移来源不进入可选列表。 */
export function createTeamRunRoutes(workflows: Record<string, ReturnType<Mastra['getWorkflow']>>, config: PracticeConfig) {
  const account = createWorkbenchAccount(config.databaseUrl);
  const busy = new Set<string>();
  /** 路由团队参数必须来自登记映射。 */
  function workflowFor(team: string) { return workflows[teamWorkflowKeys[z.enum(teamIds).parse(team)]]; }
  /** 与主工作台一致，仅允许本机页面发起写操作。 */
  function assertOrigin(c: { req: { header: (name: string) => string | undefined; url: string } }) {
    const origin = c.req.header('origin');
    if (origin && ![new URL(c.req.url).origin, 'http://127.0.0.1:4112'].includes(origin)) throw new Error('请从本机页面提交');
  }
  return [
    ...teamIds.flatMap(team => createPlatformRecoveryRoutes(workflows[teamWorkflowKeys[team]] as IntakeWorkflow, config, { workflowName: teamWorkflowIds[team], path: `/platform-api/teams/${team}/runs/:runId/dependency-repair` })),
    registerApiRoute('/intake-api/team-input-packages/:runId', { method: 'GET',
      /** 读取原生准备、确认和撤销状态，正文来自服务端登记。 */
      handler: async c => {
        try {
          const snapshot = await workflows.teamInputPackage.getWorkflowRunById(z.uuid().parse(c.req.param('runId')));
          if (!snapshot) throw new Error('不存在');
          return c.json({ runId: snapshot.runId, status: snapshot.status, steps: snapshot.steps });
        } catch { return c.json({ error: '输入包不可读取。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/team-input-packages', { method: 'POST',
      /** 先登记待确认材料，不将客户端正文视作批准或 QA 证据。 */
      handler: async c => {
        let lock: string | undefined; let acquired = false;
        try {
          assertOrigin(c);
          if (!account.current(c)) return c.json({ error: '请登录后登记。' }, 401);
          const request = z.object({ runId: z.uuid(), input: teamRunInputSchema }).strict().parse(await c.req.json());
          lock = `package:${request.runId}`;
          if (busy.has(lock)) throw new Error('输入包处理中');
          busy.add(lock); acquired = true;
          if (request.input.inputPackage) throw new Error('禁止嵌套');
          selectProjectConfig(config, request.input.projectId);
          const workflow = workflows.teamInputPackage;
          const existing = await workflow.getWorkflowRunById(request.runId);
          if (existing) {
            if (developmentHash(existing.payload) !== developmentHash(request.input)) throw new Error('已有材料不同');
          } else await (await workflow.createRun({ runId: request.runId })).start({ inputData: request.input });
          const saved = await workflow.getWorkflowRunById(request.runId);
          if (saved?.status !== 'suspended') throw new Error('材料校验未完成');
          return c.json({ runId: request.runId, status: saved?.status, steps: saved?.steps });
        } catch { return c.json({ error: '输入包登记未完成，请回读并核对材料。' }, 409); }
        finally { if (lock && acquired) busy.delete(lock); }
      },
    }),
    registerApiRoute('/intake-api/team-input-packages/:runId/respond', { method: 'POST',
      /** 确认和撤销只恢复当前暂停点，身份始终由服务端盖章。 */
      handler: async c => {
        let lock: string | undefined; let acquired = false;
        try {
          assertOrigin(c);
          const reviewer = account.current(c);
          if (!reviewer) return c.json({ error: '请登录后确认。' }, 401);
          const input = z.object({ action: z.enum(['confirm', 'revoke']), hash: z.string().length(64), comment: z.string().trim().min(1).max(2000) }).strict().parse(await c.req.json());
          const runId = z.uuid().parse(c.req.param('runId'));
          lock = `package:${runId}`;
          if (busy.has(lock)) throw new Error('输入包处理中');
          busy.add(lock); acquired = true;
          const step = input.action === 'confirm' ? 'confirm-package' : 'revoke-package';
          const workflow = workflows.teamInputPackage;
          const saved = await workflow.getWorkflowRunById(runId);
          const entry = saved?.steps?.[step];
          if (saved?.status !== 'suspended' || !entry || Array.isArray(entry) || entry.status !== 'suspended') throw new Error('关口已变化');
          if ((entry.suspendPayload as { hash?: string })?.hash !== input.hash) throw new Error('输入包版本已变化');
          await (await workflow.createRun({ runId })).resume({ step, resumeData: { hash: input.hash, comment: input.comment, reviewer } });
          const result = await workflow.getWorkflowRunById(runId);
          if (result?.status === 'failed') throw new Error('原生关口执行失败');
          return c.json({ runId, status: result?.status, steps: result?.steps });
        } catch { return c.json({ error: '输入包决定未提交，请核对当前版本。' }, 409); }
        finally { if (lock && acquired) busy.delete(lock); }
      },
    }),
    registerApiRoute('/intake-api/teams/:team/sources', { method: 'GET',
      /** 按项目筛选并逐项核验来源，客户端不提交候选或批准正文。 */
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try {
          const team = z.enum(['development', 'testing', 'delivery']).parse(c.req.param('team'));
          const selected = selectProjectConfig(config, c.req.query('projectId'));
          const sources = [];
          for (const key of businessWorkflowSchema.options) {
            const workflow = workflows[key];
            if (!workflow) continue;
            const list = await workflow.listWorkflowRuns({ page: 0, perPage: 30 });
            for (const run of list.runs) {
              try {
                const source = await resolveTeamSource(c.get('mastra'), selected, team, { workflow: key, runId: run.runId });
                sources.push({ workflow: key, runId: run.runId, hash: source.hash, brief: source.product?.brief ?? source.lifecycle?.brief ?? source.development?.input.source.content });
              } catch { /* 列表只包含满足团队输入契约的来源。 */ }
            }
          }
          return c.json({ sources });
        } catch { return c.json({ error: '团队来源暂不可读取，请核对项目与来源状态。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/teams/:team/runs', { method: 'GET',
      /** 返回独立团队自己的原生记录。 */
      handler: async c => {
        try {
          const workflow = workflowFor(c.req.param('team'));
          const selected = selectProjectConfig(config, c.req.query('projectId'));
          const list = await workflow.listWorkflowRuns({ page: 0, perPage: 30 });
          const runs = await Promise.all(list.runs.map(run => readIntake(workflow as IntakeWorkflow, run.runId, config)));
          return c.json({ runs: runs.filter(run => run.projectId === (selected.engineeringProject?.id ?? 'hrm')) });
        } catch { return c.json({ error: '团队运行记录暂不可读取。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/teams/:team/runs', { method: 'POST',
      /** 确定 Run ID 配合 Store 中的初始化输入支持丢失响应后的对账。 */
      handler: async c => {
        let lock: string | undefined; let acquired = false;
        try {
          assertOrigin(c);
          if (!account.current(c)) return c.json({ error: '请登录后启动团队。' }, 401);
          const raw = await c.req.json();
          if (raw.inputPackage) {
            const reference = z.object({ runId: z.uuid(), hash: z.string().length(64) }).strict().parse(raw.inputPackage);
            raw.input = { ...await resolveInputPackage(c.get('mastra'), config, reference), inputPackage: reference };
            delete raw.inputPackage;
          }
          const request = z.object({ runId: z.uuid(), input: teamRunInputSchema }).strict().parse(raw);
          if (request.input.team !== c.req.param('team')) throw new Error('团队不一致');
          selectProjectConfig(config, request.input.projectId);
          const workflow = workflowFor(request.input.team);
          lock = `${request.input.team}:${request.runId}`;
          if (busy.has(lock)) throw new Error('处理中');
          busy.add(lock);
          acquired = true;
          const saved = await workflow.getWorkflowRunById(request.runId);
          if (saved) {
            const initial = saved.steps?.['initialize-team-run'];
            const binding = initial && !Array.isArray(initial) ? (initial.output as any)?.teamRun : undefined;
            if (!binding || developmentHash(binding.input) !== developmentHash(request.input)) throw new Error('已有 Run 输入不一致');
          } else {
            const run = await workflow.createRun({ runId: request.runId });
            await run.start({ inputData: request.input });
          }
          return c.json(await readIntake(workflow as IntakeWorkflow, request.runId, config));
        } catch { return c.json({ error: '团队启动未完成，请回读当前记录并核对来源版本。' }, 409); }
        finally { if (lock && acquired) busy.delete(lock); }
      },
    }),
    registerApiRoute('/intake-api/teams/:team/runs/:runId', { method: 'GET',
      /** 当前状态只从原生 Store 读取。 */
      handler: async c => {
        try { return c.json(await readIntake(workflowFor(c.req.param('team')) as IntakeWorkflow, z.uuid().parse(c.req.param('runId')), config)); }
        catch { return c.json({ error: '团队运行暂不可读取。' }, 409); }
      },
    }),
    registerApiRoute('/intake-api/teams/:team/runs/:runId/respond', { method: 'POST',
      /** 复用原有版本校验和账号盖章，团队入口不能绕过人工关口。 */
      handler: async c => {
        let lock: string | undefined; let acquired = false;
        try {
          assertOrigin(c);
          const reviewer = account.current(c);
          if (!reviewer) return c.json({ error: '请登录后提交决定。' }, 401);
          const team = z.enum(teamIds).parse(c.req.param('team'));
          const runId = z.uuid().parse(c.req.param('runId'));
          lock = `${team}:${runId}`;
          if (busy.has(lock)) throw new Error('处理中');
          busy.add(lock);
          acquired = true;
          const input = await c.req.json();
          if (input.repositoryScope) {
            const selected = snapshotProjectConfig(config, await workflowFor(team).getWorkflowRunById(runId));
            const selection = z.object({ catalogHash: z.string().length(64), maxReworks: z.number().int().min(0).max(3).default(1), comment: z.string().trim().min(1).max(2000), autonomy: z.unknown().optional() }).strict().parse(input.repositoryScope);
            const registered = selected.engineeringProject ? loadEngineeringProject(selected.engineeringProject) : undefined;
            if (registered && registered.catalog.catalogHash !== selection.catalogHash) throw new Error('项目目录已变化');
            const project = registered?.candidate ?? assembleRepositoryProject(selected.hrmRepositoryRoot, selection.catalogHash);
            return c.json(await respondIntake(workflowFor(team) as IntakeWorkflow, config.mode, runId, { gateHash: input.gateHash, data: { project, reviewer, comment: selection.comment, maxReworks: selection.maxReworks, autonomy: selection.autonomy } }, config));
          }
          if (input.data?.project) throw new Error('项目范围只能从服务端目录确认');
          return c.json(await respondIntake(workflowFor(team) as IntakeWorkflow, config.mode, runId, { ...input, reviewer, ...(input.data ? { data: { ...input.data, reviewer } } : {}) }, config));
        } catch { return c.json({ error: '团队决定未提交，请刷新核对关口版本。' }, 409); }
        finally { if (lock && acquired) busy.delete(lock); }
      },
    }),
  ];
}
