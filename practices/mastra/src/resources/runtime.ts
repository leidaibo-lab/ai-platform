/** 原生Workflow步骤装饰器：持久化仍归Mastra，ALS仅持有当前执行段。 */
import type { MastraCompositeStore } from '@mastra/core/storage';
import type { PracticeConfig } from '../mastra/config.js';
import { verifyArtifact } from './artifact.js';
import { ensureRoleCatalog, validateRoleTools, type RoleAgents } from './catalog.js';
import { resolveRole } from './native-store.js';
import { currentResources, withResources } from './scope.js';
import { endpointHash, frozenResourcesSchema, freezeStepId, resourceHash, resourceWorkflowId, ResourceError, type FrozenResources } from './contracts.js';
import { loadRuntimeResourceConfig, runtimeConfigHash, frozenRuntimeResourceConfig } from './resource-config.js';
import { captureSourceSnapshot, verifySourceSnapshot } from './source-snapshot.js';

const workflowConfigs = new WeakMap<object, PracticeConfig>();
/** 服务端Workflow装配配置，仅供同进程业务命令预校验，不接受客户端覆盖。 */
export function resourceWorkflowConfig(workflow: object) { return workflowConfigs.get(workflow); }

/** 首步骤生成引用；步骤提交前不得调用业务Agent。 */
export async function freezeResources(storage: MastraCompositeStore, config: PracticeConfig, agents: RoleAgents, runId: string): Promise<FrozenResources> {
  const workflows = await storage.getStore('workflows');
  const previous = await workflows?.loadWorkflowSnapshot({ workflowName: resourceWorkflowId, runId });
  if ((previous?.context as any)?.[freezeStepId]?.output) return loadResources(storage, config, runId);
  const runtimeConfig = config.runtimeResources ?? loadRuntimeResourceConfig(config.rootDir);
  const artifact = verifyArtifact(config); const source = captureSourceSnapshot(config, runId); const ids = await ensureRoleCatalog(storage, config, agents);
  const store = await storage.getStore('agents'); if (!store) throw new ResourceError('STORE_UNAVAILABLE');
  const roles: FrozenResources['roles'] = {};
  for (const [key, id] of Object.entries(ids)) {
    const entity = await store.getById(id);
    if (entity?.status !== 'published' || !entity.activeVersionId) throw new ResourceError('NOT_PUBLISHED');
    const resolved = await resolveRole(storage, id, entity.activeVersionId);
    await validateRoleTools(key, resolved.config, agents, config.rootDir);
    // schema与实现同属制品，配置选择参与摘要，不把函数序列化进Run。
    roles[key] = { agentId: id, versionId: entity.activeVersionId, configHash: resolved.hash, toolContractHash: resourceHash({ artifact: artifact.digest, tools: resolved.config.tools }) };
  }
  const configHash = runtimeConfigHash(runtimeConfig);
  return frozenResourcesSchema.parse({ version: 'role-resources.v2', runId, mode: config.mode, runtimeConfig, configHash, bundleHash: resourceHash({ configHash, artifact, endpointHash: endpointHash(config.baseUrl), roles }), sourceSnapshotHash: source.hash, artifact, endpointHash: endpointHash(config.baseUrl), roles });
}

/** 恢复仅从原生已提交首步读取；不对旧Run补冻或选最新配置。 */
export async function loadResources(storage: MastraCompositeStore, config: PracticeConfig, runId: string) {
  const workflows = await storage.getStore('workflows');
  const snapshot = await workflows?.loadWorkflowSnapshot({ workflowName: resourceWorkflowId, runId });
  const output = (snapshot?.context as any)?.[freezeStepId]?.output;
  const parsed = frozenResourcesSchema.safeParse(output?.resources);
  if (!parsed.success || parsed.data.runId !== runId) throw new ResourceError('BINDING_MISSING');
  const binding = parsed.data;
  if (binding.mode !== config.mode || binding.endpointHash !== endpointHash(config.baseUrl)) throw new ResourceError('TRANSPORT_DRIFT');
  const verifiedArtifact = verifyArtifact(config, binding.artifact.digest);
  // 显式续接仍保持原绑定的签名者与保障级别；只允许部署配置预先批准的当前签名制品摘要发生变化。
  if (verifiedArtifact.assurance !== binding.artifact.assurance || verifiedArtifact.signer !== binding.artifact.signer) throw new ResourceError('ARTIFACT_DRIFT');
  verifySourceSnapshot(config, runId, binding.sourceSnapshotHash);
  const runtimeConfig = frozenRuntimeResourceConfig(binding.runtimeConfig);
  if (binding.configHash !== runtimeConfigHash(runtimeConfig)) throw new ResourceError('FROZEN_BUNDLE_MISMATCH');
  for (const pin of Object.values(binding.roles)) {
    const resolved = await resolveRole(storage, pin.agentId, pin.versionId);
    if (resolved.hash !== pin.configHash || resourceHash({ artifact: binding.artifact.digest, tools: resolved.config.tools }) !== pin.toolContractHash) throw new ResourceError('CONFIG_DRIFT');
  }
  return binding;
}

/** 递归包装原生步骤，包括嵌套恢复入口；外层作用域已核验时不重复整树I/O。 */
export function guardResourceWorkflow<T extends { steps: Record<string, any> }>(workflow: T, config: PracticeConfig): T {
  workflowConfigs.set(workflow, config);
  const visited = new Set<object>();
  /** 只包裹已有execute，不重写原生图、状态或恢复协议。 */
  function visit(flow: { steps: Record<string, any> }) {
    for (const step of Object.values(flow.steps)) {
      if (visited.has(step)) continue; visited.add(step);
      if (step.steps) visit(step);
      if (step.id === freezeStepId) continue;
      const execute = step.execute;
      if (typeof execute !== 'function') continue;
      /** 每个新执行段（包括恢复审批）先验证可信绑定，再进入业务逻辑。 */
      step.execute = async (context: any) => {
        const existing = currentResources();
        if (existing?.binding.runId === context.runId) return execute.call(step, context);
        const storage = context.mastra.getStorage(); if (!storage) throw new ResourceError('STORE_UNAVAILABLE');
        const binding = await loadResources(storage, config, context.runId);
        return withResources({ storage, binding }, /** 保留嵌套Workflow的原生this和执行作用域。 */() => execute.call(step, context));
      };
    }
  }
  visit(workflow); return workflow;
}
