/**
 * 独立验收成功恢复场景，不读取模型脚本内部状态。
 *
 * @param {object} input - 场景定义和 Runner 采集的持久化观察结果。
 * @returns {{passed: boolean, checks: object[], summary: string}} 场景结论。
 */
export function evaluateScenario({ observation }) {
  const latestRun = observation.conversation?.latestRun;
  const checks = [
    check("checkpoint-running", observation.checkpoint?.status === "running"),
    check("tool-result-committed", observation.checkpoint?.toolCalls?.[0]?.status === "completed"),
    check("assistant-not-committed-before-crash", observation.checkpoint?.assistantMessagePresent === false),
    check("active-lease-blocks-early-takeover", observation.leaseContention?.reasonCode === "lease_held"),
    check("original-run-recovered", observation.recovery?.recovered === 1 && latestRun?.id === observation.checkpoint?.runId),
    check("connector-not-replayed", observation.connectorExecutionsAfterRestart === 0),
    check("run-completed", latestRun?.status === "completed"),
    check("system-acceptance-persisted", latestRun?.acceptance?.status === "accepted"),
    check(
      "restart-recovery-recorded",
      latestRun?.resilience?.recovery?.reason === "process-restart-after-tool-result",
    ),
    check("tool-events-not-replayed", hasSingleToolExecution(observation.events)),
    check("single-user-and-assistant", hasRoles(observation.conversation?.messages, ["user", "assistant"])),
  ];
  const passed = checks.every(isPassedCheck);
  return {
    passed,
    checks,
    summary: passed ? "原 Run 从持久化 ToolResult 恢复且系统验收通过" : "恢复或验收证据不完整",
  };
}

/** 创建稳定名称的布尔检查项。 */
function check(name, passed) {
  return { name, passed: Boolean(passed) };
}

/** 判断检查项是否通过。 */
function isPassedCheck(item) {
  return item.passed;
}

/** 按顺序核对持久化消息角色，避免候选正文泄漏或重复落库。 */
function hasRoles(messages, expectedRoles) {
  if (!Array.isArray(messages) || messages.length !== expectedRoles.length) return false;
  return messages.every(
    /** 比较当前位置的消息角色。 */
    (message, index) => message.role === expectedRoles[index],
  );
}

/** 确认整个跨进程场景只有一次工具开始和一次工具完成事实。 */
function hasSingleToolExecution(events) {
  const toolEvents = (Array.isArray(events) ? events : []).filter(
    /** 只统计持久化工具生命周期事件。 */
    (event) => String(event?.type || "").startsWith("tool."),
  );
  return toolEvents.length === 2 && toolEvents[0]?.type === "tool.started" && toolEvents[1]?.type === "tool.completed";
}
