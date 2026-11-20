import { developmentSteps } from '../mastra/workflows/development-steps.js';
import { productSteps } from '../mastra/workflows/product-steps.js';
import { createHash } from 'node:crypto';
import type { WorkflowRunStatus } from '@mastra/core/workflows';
import { stateV2Schema } from '../development/v2/contracts.js';
import type { LiveOutputEvent } from './live-output.js';

/** 对外公开的执行节点状态；不包含 Mastra 内部错误和模型隐藏内容。 */
export type RunTimelineStatus = 'pending' | 'running' | 'completed' | 'failed' | 'waiting' | 'suspended' | 'cancelled';

export type RunTimelineStage = 'requirements' | 'product' | 'development' | 'testing';

/** 工作台可消费的单个执行节点事实。 */
export interface RunTimelineNode {
  id: string;
  kind: 'step' | 'agent' | 'check';
  stage: RunTimelineStage | null;
  attempt: number | null;
  title: string;
  status: RunTimelineStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  tools: string[];
  files: string[];
  modelSteps?: number;
  check?: { id: string; exitCode: number | null };
}

/** Run 时间线的稳定只读投影；Workflow/Store 仍是事实所有者。 */
export interface RunTimeline {
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  nodes: RunTimelineNode[];
  tools: string[];
  files: string[];
}

/** 面向浏览器的瞬时 Workflow 活动摘要；不包含原始事件 payload。 */
export interface RunActivityEvent {
  type: 'workflow-step';
  stepId: string | null;
  title: string;
  status: RunTimelineStatus;
  summary: string;
  occurredAt: string;
}

/** 提取公开流式输出及执行端提供的节点和任务标识，不转发原始事件。 */
export function projectLiveOutputFrame(value: unknown): { output: LiveOutputEvent; stepId?: string; taskKey?: string } | undefined {
  let current: unknown = value;
  for (let depth = 0; depth < 8; depth++) {
    if (!current || typeof current !== 'object') return undefined;
    const record = current as Record<string, unknown>;
    if (record.type === 'live-output.v1' || record.type === 'product-live-output.v1') {
      const data = record.data as Record<string, unknown> | undefined;
      const attempt = data?.attempt;
      if (!data || typeof data.role !== 'string' || !['analysis', 'clarification', 'scope-priority', 'writing', 'reviewer', 'context', 'architect', 'readiness', 'frontend', 'backend', 'infrastructure', 'testing', 'operations'].includes(data.role) || typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1 || attempt > 2) return undefined;
      let output: LiveOutputEvent | undefined;
      if (data.type === 'text' && typeof data.text === 'string' && data.text.length <= 16384) output = { type: 'text', text: data.text, role: data.role, attempt };
      if (data.type === 'tool' && typeof data.name === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(data.name) && (data.state === 'started' || data.state === 'completed' || data.state === 'failed')) output = { type: 'tool', name: data.name, state: data.state, role: data.role, attempt };
      if (!output) return undefined;
      const stepId = typeof record.stepId === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(record.stepId) ? record.stepId : undefined;
      const taskKey = typeof record.taskKey === 'string' && /^[a-f0-9]{16}$/.test(record.taskKey) ? record.taskKey : undefined;
      return { output, stepId, taskKey };
    }
    const payload = record.payload as Record<string, unknown> | undefined;
    current = payload?.output;
  }
  return undefined;
}

/** 保持现有流投影调用方的输出契约。 */
export function projectLiveOutputEvent(value: unknown): LiveOutputEvent | undefined {
  return projectLiveOutputFrame(value)?.output;
}

/** 兼容既有产品流调用者；当前投影已覆盖完整团队角色。 */
export const projectProductStreamEvent = projectLiveOutputEvent;

interface SnapshotLike {
  status: WorkflowRunStatus | string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  result?: unknown;
  steps?: Record<string, unknown>;
}

interface StepResultLike {
  status?: string;
  startedAt?: number;
  endedAt?: number;
}

interface WorkFact {
  role: string;
  tools: string[];
  files: string[];
  steps: number;
  round?: number;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

const roleTitles: Record<string, string> = {
  analysis: '产品经理：需求分析',
  clarification: '产品经理：需求澄清',
  'scope-priority': '产品经理：范围与优先级',
  writing: '产品经理：产品稿写作',
  context: '上下文 Agent',
  architect: '架构 Agent',
  readiness: '就绪评估 Agent',
  frontend: '前端实现 Agent',
  backend: '后端实现 Agent',
  infrastructure: '基础设施 Agent',
  'self-check': '研发自检 Agent',
  reviewer: '代码评审 Agent',
};

const stepTitles: Record<string, string> = {
  'initialize-product-development': '初始化产研流程',
  'initialize-delivery-lifecycle': '初始化交付生命周期',
  'product-team': '产品团队',
  'product-direction': '对齐方向',
  'product-specification': '完善规格',
  'align-product-requirements': productSteps[0].title,
  'product-analysis': '需求分析',
  'product-clarification': '需求澄清整理',
  'product-scope-priority': '范围与优先级',
  'product-writing': productSteps[1].title,
  'review-product-quality': productSteps[2].title,
  'guided-requirements': '需求澄清',
  'analyze-requirements': '整理需求待决项',
  'confirm-requirements': '确认本轮需求澄清',
  'review-product': productSteps[3].title,
  'analyze-blocker-questions': '整理业务缺口',
  'confirm-blocker-answers': '确认业务缺口澄清',
  'write-revised-product': '修订产品稿',
  'review-revised-product': '审阅修订产品稿',
  'development-team': '研发团队执行',
  'test-team': '测试团队执行',
  'prepare-test-plan': '准备测试计划',
  'approve-test-cases': '确认测试用例',
  'review-test-results': '确认测试结果',
  'testing-team': '测试团队执行',
  'deployment-team': '发布团队执行',
  'delivery-team': '交付团队',
  'submit-merge-request': '向 main 提交 MR',
  'confirm-final-delivery': '确认最终交付',
};

/** 将 Mastra Step 状态映射为工作台有限状态集合。 */
function mapStatus(status: string | undefined): RunTimelineStatus {
  if (status === 'success') return 'completed';
  if (status === 'failed' || status === 'tripwire') return 'failed';
  if (status === 'suspended') return 'suspended';
  if (status === 'waiting' || status === 'paused') return 'waiting';
  if (status === 'canceled' || status === 'cancelled' || status === 'bailed') return 'cancelled';
  if (status === 'running') return 'running';
  return 'pending';
}

/** 将 Unix 毫秒时间转换为稳定 ISO 字符串。 */
function isoTime(value: number | Date | string | undefined): string | null {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 计算已结束或正在运行节点的安全耗时。 */
function durationMs(startedAt: number | null, endedAt: number | null, now = Date.now()): number | null {
  if (startedAt === null) return null;
  return Math.max(0, (endedAt ?? now) - startedAt);
}

/** 将嵌套步骤名压缩为用户可理解的节点标题。 */
export function titleForStep(path: string): string {
  const leaf = path.split('.').at(-1) ?? path;
  const developmentStep = developmentSteps.find(step => step.id === leaf);
  if (developmentStep) return developmentStep.title;
  if (leaf === 'product-writing' && /(?:draft-product|product-specification)\./.test(path)) return '产品稿写作';
  return stepTitles[leaf] ?? leaf.replaceAll('-', ' ');
}

/** 将原生 Workflow 事件压缩为可直接展示的安全活动摘要。 */
export function projectWorkflowActivity(eventType: string, stepId: string | null, status: string | null, occurredAt = new Date().toISOString()): RunActivityEvent {
  const eventStatus = eventType === 'workflow-step-start'
    ? 'running'
    : eventType === 'workflow-step-suspended'
      ? 'suspended'
      : eventType === 'workflow-step-waiting'
        ? 'waiting'
        : eventType === 'workflow-step-finish' || eventType === 'workflow-step-result'
          ? 'completed'
          : mapStatus(status ?? undefined);
  const title = stepId ? titleForStep(stepId) : eventType === 'workflow-start' ? '初始化产研流程' : '整理当前阶段结果';
  const summary = eventStatus === 'running'
    ? `正在处理“${title}”，整理当前阶段的公开执行事实。`
    : eventStatus === 'completed'
      ? `已完成“${title}”，正在同步下一步。`
      : eventStatus === 'suspended'
        ? `“${title}”已暂停，等待后续确认。`
        : eventStatus === 'waiting'
          ? `“${title}”正在等待继续执行。`
          : `“${title}”当前状态：${eventStatus}。`;
  return { type: 'workflow-step', stepId, title, status: eventStatus, summary, occurredAt };
}

/** 从快照结果和已提交步骤输出中提取业务状态，而不递归展示完整模型结果。 */
/** 从 Agent 工具结果中提取白名单工具和文件路径，拒绝把参数或结果正文带到 UI。 */
export function projectToolFacts(toolResults: unknown): { tools: string[]; files: string[] } {
  const tools = new Set<string>();
  const files = new Set<string>();
  if (!Array.isArray(toolResults)) return { tools: [], files: [] };
  for (const item of toolResults) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : record;
    const toolName = typeof payload.toolName === 'string' ? payload.toolName : undefined;
    if (!toolName) continue;
    tools.add(toolName);
    const args = payload.args ?? payload.input ?? record.args ?? record.input;
    if (!args || typeof args !== 'object') continue;
    const path = (args as Record<string, unknown>).path;
    if (typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('..')) files.add(path);
  }
  return { tools: [...tools].sort(), files: [...files].sort() };
}

/** 从结果和步骤输出中提取已保存的业务执行元数据，并按事实指纹去重。 */
function collectFacts(snapshot: SnapshotLike): { work: WorkFact[]; files: string[]; checks: Array<{ id: string; exitCode: number | null; durationMs: number }> } {
  const candidates: unknown[] = [snapshot.result];
  for (const value of Object.values(snapshot.steps ?? {})) {
    if (Array.isArray(value)) candidates.push(...value);
    else candidates.push(value);
  }
  const work = new Map<string, WorkFact>();
  const files = new Set<string>();
  const checks: Array<{ id: string; exitCode: number | null; durationMs: number }> = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const possibleStates = [record, record.output, record.payload, (record.output as Record<string, unknown> | undefined)?.development];
    for (const possible of possibleStates) {
      if (!possible || typeof possible !== 'object') continue;
      const possibleRecord = possible as Record<string, unknown>;
      const parsed = stateV2Schema.safeParse(possible);
      if (parsed.success) {
        for (const entry of parsed.data.work) {
          const fact = entry as typeof entry & Partial<Pick<WorkFact, 'files' | 'round' | 'startedAt' | 'endedAt' | 'durationMs'>>;
          const normalized: WorkFact = { role: entry.role, tools: entry.tools, files: fact.files ?? [], steps: entry.steps, ...(fact.round === undefined ? {} : { round: fact.round }), ...(fact.startedAt ? { startedAt: fact.startedAt } : {}), ...(fact.endedAt ? { endedAt: fact.endedAt } : {}), ...(fact.durationMs === undefined ? {} : { durationMs: fact.durationMs }) };
          const key = JSON.stringify(normalized);
          work.set(key, normalized);
        }
        for (const path of Object.keys(parsed.data.context?.files ?? {})) files.add(path);
        for (const check of parsed.data.checks) checks.push({ id: check.id, exitCode: check.exitCode ?? null, durationMs: check.durationMs });
        for (const history of parsed.data.verificationHistory ?? []) {
          for (const check of history.checks) checks.push({ id: check.id, exitCode: check.exitCode ?? null, durationMs: check.durationMs });
        }
      }
      const productWork = (possibleRecord.productWork as { entries?: Array<{ role: string; toolNames: string[]; modelSteps: number; files?: string[]; startedAt?: string; endedAt?: string; durationMs?: number }> } | undefined)?.entries;
      for (const entry of productWork ?? []) {
        const fact: WorkFact = { role: entry.role, tools: entry.toolNames, files: entry.files ?? [], steps: entry.modelSteps, ...(entry.startedAt ? { startedAt: entry.startedAt } : {}), ...(entry.endedAt ? { endedAt: entry.endedAt } : {}), ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }) };
        work.set(JSON.stringify(fact), fact);
      }
    }
  }
  return { work: [...work.values()], files: [...files].sort(), checks };
}

/** 根据已知步骤路径投影展示阶段，未知路径保持空值。 */
function stageForStep(path: string): RunTimelineStage | null {
  if (/align-product-requirements|product-direction|guided-requirements|product-analysis|product-clarification|product-scope-priority/.test(path)) return 'requirements';
  if (/product-specification|product-writing|review-product/.test(path)) return 'product';
  if (/development-team/.test(path)) return 'development';
  if (/testing-team|deployment-team|delivery-team|submit-merge-request|confirm-final-delivery/.test(path)) return 'testing';
  return null;
}

/** 对已保存事实生成不受数组排序影响的公开标识。 */
function factId(kind: string, fact: unknown): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(fact)).digest('hex').slice(0, 20)}`;
}

/** 从原生 Workflow 快照生成工作台的节点、工具和文件读取投影。 */
export function projectRunTimeline(snapshot: SnapshotLike): RunTimeline {
  const now = Date.now();
  const nodes: RunTimelineNode[] = [];
  const timelineTools = new Set<string>();
  const facts = collectFacts(snapshot);
  const files = new Set(facts.files);
  for (const entry of facts.work) {
    for (const tool of entry.tools) timelineTools.add(tool);
    for (const path of entry.files) files.add(path);
  }

  for (const [path, raw] of Object.entries(snapshot.steps ?? {})) {
    const results = Array.isArray(raw) ? raw : [raw];
    results.forEach((value, index) => {
      if (!value || typeof value !== 'object') return;
      const result = value as StepResultLike;
      const started = typeof result.startedAt === 'number' ? result.startedAt : null;
      const ended = typeof result.endedAt === 'number' ? result.endedAt : null;
      nodes.push({
        id: index === 0 ? path : `${path}#${index + 1}`,
        kind: 'step',
        stage: stageForStep(path),
        attempt: Array.isArray(raw) ? index + 1 : null,
        title: titleForStep(path),
        status: mapStatus(result.status),
        startedAt: isoTime(started ?? undefined),
        endedAt: isoTime(ended ?? undefined),
        durationMs: durationMs(started, ended, now),
        tools: [],
        files: [],
      });
    });
  }

  facts.work.forEach(entry => {
    for (const tool of entry.tools) timelineTools.add(tool);
    nodes.push({
      id: factId('agent', entry),
      kind: 'agent',
      stage: ['analysis', 'clarification', 'scope-priority'].includes(entry.role) ? 'requirements' : entry.role === 'writing' ? 'product' : ['context', 'architect', 'readiness', 'frontend', 'backend', 'infrastructure', 'self-check', 'reviewer'].includes(entry.role) ? 'development' : null,
      attempt: entry.round ?? null,
      title: roleTitles[entry.role] ?? `${entry.role} Agent`,
      status: 'completed',
      startedAt: entry.startedAt ?? null,
      endedAt: entry.endedAt ?? null,
      durationMs: entry.durationMs ?? (entry.startedAt ? durationMs(Date.parse(entry.startedAt), entry.endedAt ? Date.parse(entry.endedAt) : null, now) : null),
      tools: [...entry.tools],
      files: [...entry.files],
      modelSteps: entry.steps,
    });
  });

  const checkOccurrences = new Map<string, number>();
  facts.checks.forEach(check => {
    const baseId = factId('check', check);
    const occurrence = (checkOccurrences.get(baseId) ?? 0) + 1;
    checkOccurrences.set(baseId, occurrence);
    nodes.push({
    id: `${baseId}:${occurrence}`,
    kind: 'check',
    stage: 'development',
    attempt: null,
    title: `检查：${check.id}`,
    status: check.exitCode === 0 ? 'completed' : 'failed',
    startedAt: null,
    endedAt: null,
    durationMs: check.durationMs,
    tools: ['runChecks'],
    files: [],
    check: { id: check.id, exitCode: check.exitCode },
  });
  });

  nodes.sort((left, right) => {
    if (!left.startedAt && !right.startedAt) return left.id.localeCompare(right.id);
    if (!left.startedAt) return 1;
    if (!right.startedAt) return -1;
    return left.startedAt.localeCompare(right.startedAt);
  });
  const startedAt = isoTime(snapshot.createdAt);
  const endedAt = ['running', 'pending', 'waiting'].includes(snapshot.status) ? null : isoTime(snapshot.updatedAt);
  const startMs = startedAt ? Date.parse(startedAt) : null;
  const endMs = endedAt ? Date.parse(endedAt) : null;
  return {
    startedAt,
    endedAt,
    durationMs: durationMs(startMs, endMs, now),
    nodes,
    tools: [...timelineTools].sort(),
    files: [...files].sort(),
  };
}
