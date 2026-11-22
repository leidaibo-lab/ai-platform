/** 输入包以原生 Workflow 暂停步骤保存确认和撤销事实，不创建独立审批数据库。 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { Mastra } from '@mastra/core';
import { z } from 'zod';
import type { PracticeConfig } from '../mastra/config.js';
import { assertProjectCorrelation, createProjectCorrelation, selectProjectConfig } from '../business-engineering/project.js';
import { correlationSchema } from '../delivery/asset-identity.js';
import { developmentHash } from '../development/contracts.js';
import { resolveTeamSource, teamRunInputSchema, type TeamRunInput } from './runs.js';

const materialSchema = teamRunInputSchema.refine(input => !input.inputPackage, '输入包不能嵌套引用');
const packageSchema = z.object({ version: z.literal('team-input-package.v1'), mode: z.enum(['fixture', 'live']), input: materialSchema, hash: z.string().length(64), correlation: correlationSchema });
const confirmationSchema = z.object({ hash: z.string().length(64), reviewer: z.string().min(1), comment: z.string().trim().min(1).max(2000) }).strict();
const confirmedSchema = packageSchema.extend({ confirmation: confirmationSchema });

/** 每次接入或确认都重新核验服务端项目和适用团队的来源证据。 */
async function validateMaterial(mastra: Mastra, config: PracticeConfig, input: TeamRunInput) {
  const selected = selectProjectConfig(config, input.projectId);
  if (input.team !== 'product') await resolveTeamSource(mastra, selected, input.team, input.source, input.source.hash);
  return selected;
}

/** 输入包确认后停留在可撤销关口；批准和撤销均由 Mastra Store 保存。 */
export function createTeamInputPackageWorkflow(config: PracticeConfig) {
  const prepare = createStep({ id: 'prepare-package', inputSchema: materialSchema, outputSchema: packageSchema,
    /** 冻结适用团队、项目绑定、规范输入和摘要。 */
    execute: async ({ inputData, mastra, runId }) => {
      if (!mastra) throw new Error('输入包缺少原生应用');
      const selected = await validateMaterial(mastra, config, inputData);
      const correlation = createProjectCorrelation(selected, inputData, runId);
      const value = { version: 'team-input-package.v1' as const, mode: config.mode, input: inputData, correlation };
      return { ...value, hash: developmentHash(value) };
    },
  });
  const confirm = createStep({ id: 'confirm-package', inputSchema: packageSchema, outputSchema: confirmedSchema, resumeSchema: confirmationSchema, suspendSchema: packageSchema,
    /** 确认前重验来源，拒绝旧版本和项目漂移。 */
    execute: async ({ inputData, resumeData, suspend, mastra }) => {
      if (!resumeData) return suspend(inputData);
      if (!mastra || resumeData.hash !== inputData.hash || inputData.mode !== config.mode) throw new Error('输入包版本已变化');
      const selected = await validateMaterial(mastra, config, inputData.input);
      assertProjectCorrelation(selected, inputData.correlation);
      return { ...inputData, confirmation: resumeData };
    },
  });
  const revoke = createStep({ id: 'revoke-package', inputSchema: confirmedSchema, outputSchema: confirmedSchema.extend({ revocation: confirmationSchema }), resumeSchema: confirmationSchema, suspendSchema: confirmedSchema,
    /** 确认后等待明确撤销；终态不再可用。 */
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData) return suspend(inputData);
      if (resumeData.hash !== inputData.hash) throw new Error('撤销版本不一致');
      return { ...inputData, revocation: resumeData };
    },
  });
  const workflow = createWorkflow({ id: 'team-input-package', inputSchema: materialSchema, outputSchema: confirmedSchema.extend({ revocation: confirmationSchema }) }).then(prepare).then(confirm).then(revoke).commit();
  const createRun = workflow.createRun.bind(workflow);
  const guarded = new WeakSet<object>();
  const starting = new Set<string>();
  /** 包版本不可覆写或回退；变更材料应登记新包，避免撤销后重放确认。 */
  workflow.createRun = async (...args: Parameters<typeof createRun>) => {
    const run = await createRun(...args);
    if (guarded.has(run)) return run;
    guarded.add(run);
    const native = run as any;
    for (const method of ['_start', '_resume', '_timeTravel', '_restart']) {
      const execute = native[method];
      if (typeof execute !== 'function') continue;
      /** 覆盖普通、异步和流式入口，所有执行仍委托原生 Workflow。 */
      native[method] = async (request: any, ...rest: any[]) => {
        if (method === '_timeTravel' || method === '_restart') throw new Error('输入包不能回退或重启，请登记新版本');
        if (request?.context || request?.nestedStepsContext) throw new Error('输入包不能替换原生上下文');
        if (method === '_start') {
          if (starting.has(run.runId)) throw new Error('输入包正在登记');
          starting.add(run.runId);
          try {
            const existing = await workflow.getWorkflowRunById(run.runId);
            if (existing?.steps?.['prepare-package'] || existing && existing.status !== 'pending') throw new Error('输入包不能覆盖登记');
            if (existing?.payload && developmentHash(existing.payload) !== developmentHash(request?.inputData)) throw new Error('输入包登记输入不能替换');
            return await execute.call(run, request, ...rest);
          } finally { starting.delete(run.runId); }
        }
        const snapshot = await workflow.getWorkflowRunById(run.runId);
        const prepared = snapshot?.steps?.['prepare-package'];
        if (!prepared || Array.isArray(prepared)) throw new Error('输入包缺少登记事实');
        const saved = packageSchema.parse(prepared.output);
        if (saved.mode !== config.mode) throw new Error('输入包模式已变化');
        const selected = selectProjectConfig(config, saved.input.projectId);
        assertProjectCorrelation(selected, saved.correlation);
        const path = typeof request.step === 'string' ? request.step : request.step?.join('.');
        if (path === 'confirm-package') {
          if (!workflow.mastra) throw new Error('缺少原生应用');
          await validateMaterial(workflow.mastra, config, saved.input);
        }
        return execute.call(run, request, ...rest);
      };
    }
    return run;
  };
  return workflow;
}

/** 团队初始化和恢复只接受已确认且仍停留在撤销关口的同版本输入包。 */
export async function resolveInputPackage(mastra: Mastra, config: PracticeConfig, reference: { runId: string; hash: string }): Promise<TeamRunInput> {
  const snapshot = await mastra.getWorkflow('teamInputPackage').getWorkflowRunById(reference.runId);
  const confirmation = snapshot?.steps?.['confirm-package'];
  const revocation = snapshot?.steps?.['revoke-package'];
  if (snapshot?.status !== 'suspended' || !confirmation || Array.isArray(confirmation) || confirmation.status !== 'success' || !revocation || Array.isArray(revocation) || revocation.status !== 'suspended') throw new Error('输入包尚未确认或已撤销');
  const saved = confirmedSchema.parse(confirmation.output);
  const { hash, confirmation: _confirmation, ...material } = saved;
  if (hash !== reference.hash || hash !== developmentHash(material) || saved.confirmation.hash !== hash || saved.mode !== config.mode) throw new Error('输入包版本不一致');
  const selected = await validateMaterial(mastra, config, saved.input);
  assertProjectCorrelation(selected, saved.correlation);
  return saved.input;
}
