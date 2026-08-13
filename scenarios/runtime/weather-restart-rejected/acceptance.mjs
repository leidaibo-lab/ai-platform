/**
 * 独立验收拒绝场景，确认候选没有成为消息事实或完成状态。
 *
 * @param {object} input - 场景定义和 Runner 采集的持久化观察结果。
 * @returns {{passed: boolean, checks: object[], summary: string}} 场景结论。
 */
export function evaluateScenario({ observation }) {
  const latestRun = observation.conversation?.latestRun;
  const checks = [
    check("checkpoint-running", observation.checkpoint?.status === "running"),
    check("tool-result-committed", observation.checkpoint?.toolCalls?.[0]?.status === "completed"),
    check("recovery-rejected", observation.recovery?.failed === 1),
    check("connector-not-replayed", observation.connectorExecutionsAfterRestart === 0),
    check("run-failed", latestRun?.status === "failed"),
    check("stable-error-code", latestRun?.errorCode === "result_acceptance_rejected"),
    check("rejection-persisted", latestRun?.acceptance?.status === "rejected"),
    check("source-reason-recorded", latestRun?.acceptance?.reasonCodes?.includes("weather_source_missing")),
    check("rejection-event-persisted", hasSingleRejectionEvent(observation.events)),
    check("candidate-not-persisted", hasOnlyUserMessage(observation.conversation?.messages)),
  ];
  const passed = checks.every(isPassedCheck);
  return {
    passed,
    checks,
    summary: passed ? "缺少来源的候选被系统拒绝且未形成助手消息" : "拒绝门禁证据不完整",
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

/** 确认进程退出后只保留原用户消息，不保存未验收候选。 */
function hasOnlyUserMessage(messages) {
  return Array.isArray(messages) && messages.length === 1 && messages[0]?.role === "user";
}

/** 确认拒绝结论只形成一次持久化验收事件。 */
function hasSingleRejectionEvent(events) {
  return (Array.isArray(events) ? events : []).filter(
    /** 只保留结果验收拒绝事件。 */
    (event) => event?.type === "acceptance.rejected",
  ).length === 1;
}
