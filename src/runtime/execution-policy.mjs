const POLICY_DECISIONS = new Set(["allow", "deny", "confirmation_required", "defer"]);
const SIDE_EFFECTS = new Set(["write", "external", "unknown"]);
const DEFAULT_POLICY_NAME = "execution-policy";
const DEFAULT_POLICY_VERSION = "execution-policy.v1";

/**
 * @typedef {object} ExecutionPolicyDecision
 * @property {"allow"|"deny"|"confirmation_required"|"defer"} decision - 当前执行结论。
 * @property {string} policy - 稳定策略名称。
 * @property {string} policyVersion - 不可变策略版本。
 * @property {string[]} reasonCodes - 可审计的稳定原因码。
 * @property {string} evaluatedAt - ISO 8601 评估时间。
 * @property {Array<{hook: string, code: string}>} hookErrors - 前置 Hook 的脱敏失败证据。
 */

/** 执行策略拒绝、待确认或延后时供 Runtime 使用的稳定错误。 */
export class ExecutionPolicyError extends Error {
  /**
   * @param {ExecutionPolicyDecision} policyDecision - 已冻结的策略结果。
   */
  constructor(policyDecision) {
    super(`Execution policy returned ${policyDecision.decision}`);
    this.name = "ExecutionPolicyError";
    this.code = `execution_${policyDecision.decision}`;
    this.policyDecision = policyDecision;
  }
}

/**
 * 创建版本化执行策略端口；默认允许既有 Run 和已注册只读工具，其他操作失败关闭。
 *
 * @param {object} [options] - 策略定义和 Hook。
 * @param {string} [options.policy] - 稳定策略名称。
 * @param {string} [options.policyVersion] - 不可变策略版本。
 * @param {string[]} [options.allowedRunOperations] - 显式兼容的既有 Run 操作。
 * @param {string[]} [options.allowedReadTools] - 当前 Tool Registry 启用的只读工具名。
 * @param {Array<(input: object) => Promise<object|void>|object|void>} [options.beforeHooks] - 只能收紧结论的前置 Hook。
 * @param {Array<(input: object) => Promise<void>|void>} [options.afterHooks] - 只观察已提交结果的后置 Hook。
 * @param {() => Date} [options.clock] - 测试可替换时钟。
 * @returns {object} ExecutionPolicy Port。
 */
export function createExecutionPolicy({
  policy = DEFAULT_POLICY_NAME,
  policyVersion = DEFAULT_POLICY_VERSION,
  allowedRunOperations = ["conversation.chat", "image.generate", "image.edit"],
  allowedReadTools = [],
  beforeHooks = [],
  afterHooks = [],
  clock = createCurrentDate,
} = {}) {
  const definition = Object.freeze({
    policy: requireStableIdentifier(policy, "policy"),
    policyVersion: requireStableIdentifier(policyVersion, "policyVersion"),
    allowedRunOperations: new Set(normalizeIdentifierList(allowedRunOperations, "allowedRunOperations")),
    allowedReadTools: new Set(normalizeIdentifierList(allowedReadTools, "allowedReadTools")),
    beforeHooks: normalizeHooks(beforeHooks, "beforeHooks"),
    afterHooks: normalizeHooks(afterHooks, "afterHooks"),
    clock: requireClock(clock),
  });

  return Object.freeze({
    policy: definition.policy,
    policyVersion: definition.policyVersion,

    /** 根据已归一化执行上下文给出不可变前置决定，Hook 只能把决定变得更严格。 */
    async evaluateBefore(input) {
      const context = normalizeExecutionContext(input);
      let decision = createBaseDecision(definition, context);
      const hookErrors = [];
      for (const hook of definition.beforeHooks) {
        try {
          const override = await hook(deepFreeze({ context, decision }));
          decision = applyRestrictiveOverride(definition, decision, override);
        } catch {
          hookErrors.push({ hook: readHookName(hook), code: "policy_hook_failed" });
          decision = createDecision(definition, "deny", ["policy_hook_failed"]);
        }
      }
      return deepFreeze({
        ...decision,
        evaluatedAt: definition.clock().toISOString(),
        hookErrors,
      });
    },

    /** 依次运行只读后置 Hook，收集脱敏失败但不抛出或改写调用方终态。 */
    async observeAfter(input) {
      const observation = deepFreeze(normalizeAfterObservation(input));
      const failedHooks = [];
      let completed = 0;
      for (const hook of definition.afterHooks) {
        try {
          await hook(observation);
          completed += 1;
        } catch {
          failedHooks.push({ hook: readHookName(hook), code: "execution_hook_failed" });
        }
      }
      return deepFreeze({
        attempted: definition.afterHooks.length,
        completed,
        failedHooks,
      });
    },
  });
}

/** 策略结果不是 allow 时抛出携带稳定决定的错误。 */
export function assertExecutionAllowed(policyDecision) {
  if (policyDecision?.decision !== "allow") throw new ExecutionPolicyError(policyDecision);
  return policyDecision;
}

/** 依据已知 Run、Tool 和副作用边界构造默认决定。 */
function createBaseDecision(definition, context) {
  if (context.kind === "run" && definition.allowedRunOperations.has(context.operation)) {
    return createDecision(definition, "allow", ["run_operation_allowed"]);
  }
  if (
    context.kind === "tool" &&
    context.effect === "read" &&
    context.toolName &&
    definition.allowedReadTools.has(context.toolName)
  ) {
    return createDecision(definition, "allow", ["registered_read_tool_allowed"]);
  }
  if (SIDE_EFFECTS.has(context.effect) && context.known) {
    return createDecision(definition, "confirmation_required", ["side_effect_confirmation_required"]);
  }
  return createDecision(definition, "deny", ["operation_unknown"]);
}

/** 创建尚未附加评估时间和 Hook 证据的基础策略结果。 */
function createDecision(definition, decision, reasonCodes) {
  return Object.freeze({
    decision,
    policy: definition.policy,
    policyVersion: definition.policyVersion,
    reasonCodes: Object.freeze([...reasonCodes]),
  });
}

/** 校验 Hook 返回并只接受不低于当前严格程度的策略覆盖。 */
function applyRestrictiveOverride(definition, current, override) {
  if (override == null) return current;
  const decision = String(override?.decision || "");
  if (!POLICY_DECISIONS.has(decision)) throw new TypeError("policy hook returned an invalid decision");
  if (decisionRank(decision) < decisionRank(current.decision)) return current;
  const reasonCodes = normalizeReasonCodes(override.reasonCodes, "policy_hook_restricted");
  return createDecision(definition, decision, reasonCodes);
}

/** 返回策略结论的严格等级，数值越大越不允许继续执行。 */
function decisionRank(decision) {
  return {
    allow: 0,
    defer: 1,
    confirmation_required: 2,
    deny: 3,
  }[decision];
}

/** 将前置策略输入缩减为不含正文、密钥或外部响应的稳定上下文。 */
function normalizeExecutionContext(input) {
  const kind = String(input?.kind || "operation");
  if (!["run", "tool", "operation"].includes(kind)) throw new TypeError("execution kind is invalid");
  const effect = String(input?.effect || "unknown");
  if (!["read", "write", "external", "unknown"].includes(effect)) {
    throw new TypeError("execution effect is invalid");
  }
  const riskLevel = String(input?.riskLevel || defaultRiskForEffect(effect));
  if (!["low", "medium", "high", "critical"].includes(riskLevel)) {
    throw new TypeError("execution riskLevel is invalid");
  }
  return deepFreeze({
    kind,
    operation: requireStableIdentifier(input?.operation, "operation"),
    toolName: nullableIdentifier(input?.toolName),
    effect,
    riskLevel,
    known: Boolean(input?.known),
    conversationId: nullableIdentifier(input?.conversationId),
    runId: nullableIdentifier(input?.runId),
    requestId: nullableIdentifier(input?.requestId),
  });
}

/** 将后置观察输入冻结为执行上下文、策略决定和最小结果元数据。 */
function normalizeAfterObservation(input) {
  return {
    context: normalizeExecutionContext(input?.context),
    policyDecision: normalizeExistingDecision(input?.policyDecision),
    outcome: {
      status: String(input?.outcome?.status || "unknown"),
      errorCode: nullableIdentifier(input?.outcome?.errorCode),
      operationId: nullableIdentifier(input?.outcome?.operationId),
    },
  };
}

/** 校验后置 Hook 收到的是完整且稳定的既有策略结果。 */
function normalizeExistingDecision(value) {
  if (!POLICY_DECISIONS.has(value?.decision)) throw new TypeError("policyDecision is invalid");
  return {
    decision: value.decision,
    policy: requireStableIdentifier(value.policy, "policyDecision.policy"),
    policyVersion: requireStableIdentifier(value.policyVersion, "policyDecision.policyVersion"),
    reasonCodes: normalizeReasonCodes(value.reasonCodes, "policy_reason_missing"),
    evaluatedAt: String(value.evaluatedAt || ""),
  };
}

/** 根据副作用类型提供保守的默认风险等级。 */
function defaultRiskForEffect(effect) {
  if (effect === "read") return "low";
  if (effect === "write") return "high";
  return "critical";
}

/** 将 Hook 列表校验并冻结，防止运行时修改策略定义。 */
function normalizeHooks(value, fieldName) {
  if (!Array.isArray(value) || value.some(isNotFunction)) throw new TypeError(`${fieldName} must contain functions`);
  return Object.freeze([...value]);
}

/** 判断候选 Hook 是否不是函数。 */
function isNotFunction(value) {
  return typeof value !== "function";
}

/** 将标识列表去空去重并拒绝非法值。 */
function normalizeIdentifierList(value, fieldName) {
  if (!Array.isArray(value)) throw new TypeError(`${fieldName} must be an array`);
  const result = [];
  for (const item of value) {
    const identifier = requireStableIdentifier(item, fieldName);
    if (!result.includes(identifier)) result.push(identifier);
  }
  return result;
}

/** 将原因码列表整理为至少一个稳定值。 */
function normalizeReasonCodes(value, fallback) {
  const result = [];
  for (const item of Array.isArray(value) ? value : []) {
    const code = String(item || "").trim();
    if (code && !result.includes(code)) result.push(code);
  }
  return Object.freeze(result.length > 0 ? result : [fallback]);
}

/** 校验策略时钟并返回原函数。 */
function requireClock(clock) {
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  return clock;
}

/** 返回当前时间，作为生产策略默认时钟。 */
function createCurrentDate() {
  return new Date();
}

/** 校验并返回非空、无控制字符的稳定标识。 */
function requireStableIdentifier(value, fieldName) {
  const identifier = String(value || "").trim();
  if (!identifier || identifier.length > 200 || /[\r\n\0]/.test(identifier)) {
    throw new TypeError(`${fieldName} must be a stable identifier`);
  }
  return identifier;
}

/** 将可选标识规范为字符串或 null。 */
function nullableIdentifier(value) {
  const identifier = String(value || "").trim();
  return identifier || null;
}

/** 返回 Hook 的稳定调试名，不暴露错误正文。 */
function readHookName(hook) {
  return String(hook.name || "anonymous-hook").slice(0, 120);
}

/** 递归冻结普通对象和数组，使 Policy/Hook 之间只能传递不可变快照。 */
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
