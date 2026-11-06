/**
 * 独立开发执行工作流，结束于研发交付；不进入测试/运维提案链。
 * ADR: docs/decisions/2026-11-06-mastra-development-execution.md
 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { PracticeConfig } from '../config.js';
import type { DevelopmentExecution } from '../../development-execution.js';
import { architectureSchema, developmentHash, developmentInputSchema, developmentReviewSchema, developmentStateSchema, recoveryReviewSchema, validateArchitecture, type DevelopmentState } from '../../development/contracts.js';
import { generateDevelopment, parseDevelopmentJson } from '../../development/agents.js';
import { developmentRecoveryHash, invokeDevelopment, type DevelopmentGenerator } from '../../development/recovery.js';

/** 单次工作流固定一个执行目录，恢复前重新核对内容散列；不共享运行中的实例。 */
export function createDevelopmentWorkflow(config: PracticeConfig, execution: DevelopmentExecution, evaluationPolicy = false, generate: DevelopmentGenerator = generateDevelopment) {
  const initialize = createStep({ id: 'initialize-development', inputSchema: developmentInputSchema, outputSchema: developmentStateSchema,
    // 调用者不能伪造已批准方案、检查报告或研发终态。
    execute: async ({ inputData }) => developmentStateSchema.parse({ input: inputData, mode: config.mode, plan: null, planHash: null, planSourceHash: null, approvedHash: null, reviews: [], round: 0, route: 'all', work: [], checks: [], history: [], outcome: 'in-progress', delivery: null }),
  });
  const architecture = createStep({ id: 'architecture', inputSchema: developmentStateSchema, outputSchema: developmentStateSchema,
    // 方案需要显式JSON和真实任务图，架构分析不授予实现权限。
    execute: async ({ inputData }) => {
      if (inputData.outcome !== 'in-progress' || inputData.recovery || (inputData.plan && inputData.route !== 'architecture')) return inputData;
      const before = developmentHash(await execution.snapshot());
      const called = await invokeDevelopment(config, 'architect', execution, inputData, [], null, generate,
        // 在受控调用内校验模型结构，失败也保留归类和回滚事实。
        (text) => validateArchitecture(architectureSchema.parse(parseDevelopmentJson(text)), inputData.input));
      if (!called.entry) return called.state;
      const { entry, state } = called;
      const plan = architectureSchema.parse(parseDevelopmentJson(entry.text));
      validateArchitecture(plan, inputData.input);
      const planSourceHash = developmentHash(await execution.snapshot());
      if (before !== planSourceHash) throw new Error('方案生成期间源码发生漂移');
      const planHash = developmentHash({ source: inputData.input.source.hash, project: inputData.input.project, plan, planSourceHash });
      return { ...state, plan, planHash, planSourceHash, approvedHash: null, completedTasks: [], work: [...state.work, entry], outcome: plan.blockers.length ? 'clarification-required' as const : 'in-progress' as const };
    },
  });
  const gate = createStep({ id: 'approve-architecture', inputSchema: developmentStateSchema, outputSchema: developmentStateSchema,
    suspendSchema: z.object({ hash: z.string(), plan: architectureSchema }), resumeSchema: developmentReviewSchema,
    // 组织者规则确认仅供隔离评测；正式路径必须暂停，不把用户授权实现误记为审批每份方案。
    execute: async ({ inputData, resumeData, suspend }) => {
      if (inputData.outcome !== 'in-progress' || inputData.recovery || inputData.approvedHash === inputData.planHash) return inputData;
      if (inputData.mode !== config.mode) throw new Error('开发模式变化');
      if (developmentHash(await execution.snapshot()) !== inputData.planSourceHash) throw new Error('批准前候选源码已变化');
      if (!inputData.planHash || !inputData.plan) throw new Error('方案尚未生成');
      if (!resumeData && !evaluationPolicy) return suspend({ hash: inputData.planHash, plan: inputData.plan });
      const review = resumeData ?? { hash: inputData.planHash, decision: 'approve' as const, reviewer: 'evaluation-organizer-policy', comment: '离线评测自动执行，不代表人工批准或生产授权' };
      if (review.hash !== inputData.planHash) throw new Error('技术方案版本不匹配');
      return { ...inputData, approvedHash: review.decision === 'approve' ? review.hash : null,
        reviews: [...inputData.reviews, { ...review, authority: resumeData ? 'local-human-label' as const : 'evaluation-policy' as const }],
        outcome: review.decision === 'reject' ? 'rejected' as const : 'in-progress' as const };
    },
  });
  const implement = createStep({ id: 'implement', inputSchema: developmentStateSchema, outputSchema: developmentStateSchema,
    // 首版按拓扑顺序串行，返工只交给相应责任角色，跨层错误重新生成并批准方案。
    execute: async ({ inputData }) => {
      if (inputData.outcome !== 'in-progress' || inputData.recovery) return inputData;
      if (!inputData.plan || !inputData.approvedHash || inputData.approvedHash !== inputData.planHash) throw new Error('实现未获得当前方案批准');
      const expectedSource = inputData.checkpointHash ?? (inputData.route === 'architecture' || inputData.round === 0 ? inputData.planSourceHash : inputData.history.at(-1)?.sourceHash);
      if (expectedSource !== developmentHash(await execution.snapshot())) throw new Error('实现前源码与已批准或已检查版本不符');
      let state = inputData;
      for (const task of inputData.plan.tasks) {
        if (!['all', 'architecture', task.role].includes(inputData.route)) continue;
        if (state.completedTasks.includes(task.id)) continue;
        const called = await invokeDevelopment(config, task.role, execution, state, task.paths, task, generate);
        if (!called.entry) return called.state;
        const { entry } = called;
        state = { ...called.state, work: [...called.state.work, entry], completedTasks: [...called.state.completedTasks, task.id] };
        if (entry.text.includes('ARCHITECTURE_BLOCKER:')) return { ...state, route: 'architecture' as const };
      }
      return state;
    },
  });
  const check = createStep({ id: 'development-self-check', inputSchema: developmentStateSchema, outputSchema: developmentStateSchema,
    // 自检角色无写工具；最终放行依据来自再次固定执行，不相信模型的通过声明。
    execute: async ({ inputData }) => {
      if (inputData.outcome !== 'in-progress' || inputData.recovery) return inputData;
      if (inputData.route === 'architecture' && inputData.work.at(-1)?.text.includes('ARCHITECTURE_BLOCKER:'))
        return { ...inputData, round: inputData.round + 1, outcome: inputData.round >= inputData.input.maxReworks ? 'rework-exhausted' as const : 'in-progress' as const };
      const before = await execution.snapshot();
      const called = await invokeDevelopment(config, 'self-check', execution, inputData, [], null, generate);
      if (!called.entry) return called.state;
      const { entry, state } = called;
      if (developmentHash(before) !== developmentHash(await execution.snapshot())) throw new Error('自检阶段修改了源码');
      const checks = await execution.runChecks();
      if (developmentHash(before) !== developmentHash(await execution.snapshot())) throw new Error('检查执行期间源码发生漂移');
      const passed = checks.length > 0 && checks.every(
        // null/超时/信号终止均不得视为通过。
        (result) => result.exitCode === 0,
      );
      let route: DevelopmentState['route'] = 'human';
      try {
        route = z.object({ route: z.enum(['frontend', 'backend', 'infrastructure', 'architecture', 'human']) }).parse(parseDevelopmentJson(entry.text)).route;
      } catch { /* 不能解析模型归属建议时升级人工，不从自然语言猜测。 */ }
      if (!inputData.input.project.roles.includes(route as 'frontend' | 'backend' | 'infrastructure') && route !== 'architecture') route = 'human';
      const files = await execution.snapshot();
      const sourceHash = developmentHash(files);
      return { ...state, checks, round: inputData.round + 1, work: [...state.work, entry], route, completedTasks: [], checkpointHash: sourceHash,
        history: [...inputData.history, { round: inputData.round, checks, sourceHash, route }],
        outcome: passed ? 'development-delivered' as const : route === 'human' ? 'manual-attention' as const : inputData.round >= inputData.input.maxReworks ? 'rework-exhausted' as const : 'in-progress' as const,
        delivery: passed ? { version: 'development-delivery.v1' as const, productHash: inputData.input.source.hash, planHash: inputData.planHash!, sourceHash, files, checks,
          limitations: ['仅固定Node语法检查和公开smoke，不是独立测试验收', '未验证Next/Nest/PostgreSQL整栈', '无生产部署；没有生成提交时以源码树hash标识'] } : null };
    },
  });
  const recovery = createStep({ id: 'recover-development', inputSchema: developmentStateSchema, outputSchema: developmentStateSchema,
    suspendSchema: z.object({ hash: z.string(), checkpointHash: z.string(), role: z.string(), kind: z.string() }), resumeSchema: recoveryReviewSchema,
    // 只有已捕获、已回滚并持久化的故障可人工接续一次，不重放已完成任务。
    execute: async ({ inputData, resumeData, suspend }) => {
      if (inputData.outcome !== 'in-progress' || !inputData.recovery) return inputData;
      if (inputData.recoveries.length >= 1) return { ...inputData, outcome: 'manual-attention' as const };
      const checkpointHash = developmentHash(await execution.snapshot());
      if (checkpointHash !== inputData.recovery.checkpointHash || developmentRecoveryHash(inputData, checkpointHash) !== inputData.recovery.hash) throw new Error('恢复检查点发生漂移');
      if (!resumeData) return suspend(inputData.recovery);
      if (resumeData.hash !== inputData.recovery.hash) throw new Error('恢复版本不匹配');
      return { ...inputData, recoveries: [...inputData.recoveries, resumeData], recovery: null,
        outcome: resumeData.decision === 'stop' ? 'manual-attention' as const : 'in-progress' as const };
    },
  });
  const iteration = createWorkflow({ id: 'development-iteration', inputSchema: developmentStateSchema, outputSchema: developmentStateSchema })
    .then(architecture).then(gate).then(implement).then(check).then(recovery).commit();
  return createWorkflow({ id: 'development-execution', inputSchema: developmentInputSchema, outputSchema: developmentStateSchema }).then(initialize)
    .dountil(iteration,
      // 有界重做由原生循环保存状态；没有本地递归调度器。
      async ({ inputData }) => inputData.outcome !== 'in-progress',
    ).commit();
}
