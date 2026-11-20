import { canWriteProjectPath, developmentHash } from '../development/contracts.js';
import { stateV2Schema } from '../development/v2/contracts.js';
import { contentHash } from '../delivery/remote-handoff.js';
import type { PracticeConfig } from '../mastra/config.js';
import { executionResolver } from '../mastra/workflows/development-team.js';
import type { IntakeWorkflow } from './service.js';

const checkpointSteps = new Set(['approve-architecture', 'merge-team-results', 'develop-and-check', 'implement', 'development-self-check', 'review-development-quality', 'review-code', 'assess-delivery', 'plan-development', 'prepare-revised-development']);

/** 读取原生检查点的候选差异，只返回批准任务中可展示的文件。 */
export async function readCandidateChanges(workflow: IntakeWorkflow, runId: string, config: PracticeConfig) {
  const run = await workflow.getWorkflowRunById(runId);
  const saved = Object.entries(run?.steps ?? {}).flatMap(([path, step]) => {
    const leaf = path.replace(/#\d+$/, '').split('.').at(-1)!;
    if (Array.isArray(step) || step.status !== 'success' || !checkpointSteps.has(leaf)) return [];
    return [{ output: step.output, endedAt: step.endedAt ?? 0 }];
  }).sort((a, b) => b.endedAt - a.endedAt);
  const final = run?.status === 'success' ? stateV2Schema.safeParse((run.result as { development?: unknown } | undefined)?.development).data : undefined;
  const latest = saved[0];
  const state = final ?? stateV2Schema.safeParse(latest?.output).data;
  if (!state?.approvedHash || !state.plan || state.input.source.runId !== runId) return { status: 'pending' as const };

  const execution = executionResolver(config, { requireExisting: true })(state.input);
  try {
    const snapshot = await execution.snapshot();
    if (developmentHash(snapshot) !== state.checkpointHash) return { status: 'unavailable' as const };
    const project = state.input.project;
    const files = [];
    let remaining = 500_000;
    for (const task of state.plan.tasks) for (const path of task.paths) {
      if (!canWriteProjectPath(project, path) || /secret|credential|private[-_]?key/i.test(path)) continue;
      const before = Object.hasOwn(project.files, path) ? project.files[path] : undefined;
      const afterHash = snapshot[path];
      if (before === undefined ? afterHash === undefined || afterHash === contentHash('') : afterHash === contentHash(before)) continue;
      const kind = before === undefined ? 'added' : afterHash === undefined ? 'deleted' : 'modified';
      const after = afterHash === undefined ? '' : await execution.readFile(path);
      if (afterHash !== undefined && contentHash(after) !== afterHash) return { status: 'unavailable' as const };
      const bytes = Buffer.byteLength(before ?? '') + Buffer.byteLength(after);
      const omitted = bytes > 100_000 || bytes > remaining || (before ?? '').includes('\0') || after.includes('\0');
      if (!omitted) remaining -= bytes;
      files.push({ path, taskId: task.id, kind, ...(omitted ? {} : { before: before ?? '', after }) });
    }
    return { status: 'ready' as const, sourceHash: state.checkpointHash, baseline: project.engineeringRevision ?? developmentHash(project.files), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  } finally {
    await execution.close();
  }
}
