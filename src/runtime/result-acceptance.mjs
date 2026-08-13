/**
 * @typedef {object} AcceptanceResult
 * @property {string} policy - 稳定验收策略名称。
 * @property {string} policyVersion - 可追溯规则版本。
 * @property {"accepted"|"rejected"} status - 系统独立接受结论。
 * @property {string[]} reasonCodes - 稳定原因码，不包含候选正文。
 * @property {object} evidence - 最小事实绑定证据。
 * @property {string} evaluatedAt - ISO 8601 验收时间。
 */

const WEATHER_POLICY = Object.freeze({
  policy: "weather-answer",
  policyVersion: "weather-answer.v1",
  toolNames: Object.freeze(["get_weather"]),
  evaluate: evaluateWeatherAnswer,
});

/**
 * 创建按工具名选择确定性结果验收策略的注册表。
 *
 * Strategy Registry 模式把 Runtime 执行流程与场景验收规则分离；新增场景只注册策略，
 * 不在 Runtime 主链继续增加业务条件分支。
 *
 * @param {object[]} [policies] - 具有唯一工具归属的验收策略。
 * @returns {object} 验收策略查询和执行接口。
 */
export function createResultAcceptanceRegistry(policies = [WEATHER_POLICY]) {
  const policiesByToolName = new Map();
  for (const policy of policies) {
    validatePolicy(policy);
    for (const toolName of policy.toolNames) {
      if (policiesByToolName.has(toolName)) throw new TypeError(`duplicate acceptance policy for ${toolName}`);
      policiesByToolName.set(toolName, policy);
    }
  }

  return {
    /** 判断指定工具的候选结果是否必须经过系统验收后才能交付。 */
    requiresTool(toolName) {
      return policiesByToolName.has(String(toolName || ""));
    },

    /**
     * 根据实际持久化 ToolCall 选择唯一策略并验收候选正文。
     *
     * @param {{candidateContent: string, toolCalls: object[]}} input - 模型候选和 SQLite 工具事实。
     * @returns {AcceptanceResult|null} 没有受管工具时返回 null。
     */
    evaluate(input) {
      const toolCalls = Array.isArray(input?.toolCalls) ? input.toolCalls : [];
      const matchedPolicies = new Set();
      for (const toolCall of toolCalls) {
        const policy = policiesByToolName.get(String(toolCall?.toolName || ""));
        if (policy) matchedPolicies.add(policy);
      }
      if (matchedPolicies.size === 0) return null;
      if (matchedPolicies.size > 1) {
        return createAcceptanceResult({
          policy: "combined-tool-answer",
          policyVersion: "combined-tool-answer.v1",
          status: "rejected",
          reasonCodes: ["multiple_acceptance_policies_unsupported"],
          evidence: buildToolEvidence(toolCalls),
        });
      }
      const [policy] = matchedPolicies;
      const governedCalls = toolCalls.filter(
        /** 只把当前策略拥有的工具事实交给领域验收器。 */
        (toolCall) => policy.toolNames.includes(String(toolCall?.toolName || "")),
      );
      return policy.evaluate({
        candidateContent: String(input?.candidateContent || ""),
        toolCalls: governedCalls,
      });
    },
  };
}

/** 校验验收策略必须声明稳定名称、版本、工具集合和执行器。 */
function validatePolicy(policy) {
  if (!policy?.policy || !policy?.policyVersion) throw new TypeError("acceptance policy and version are required");
  if (!Array.isArray(policy.toolNames) || policy.toolNames.length === 0) {
    throw new TypeError("acceptance policy toolNames are required");
  }
  if (typeof policy.evaluate !== "function") throw new TypeError("acceptance policy evaluate is required");
}

/** 根据 weather.v1 ToolResult 检查地点、时间、来源和至少一个结果事实。 */
function evaluateWeatherAnswer({ candidateContent, toolCalls }) {
  const content = normalizeEvidenceText(candidateContent);
  const reasonCodes = [];
  const checks = {
    candidatePresent: content.length > 0,
    toolFactsTerminal: toolCalls.length > 0 && toolCalls.every(isTerminalToolCall),
    locationBound: true,
    dataTimeBound: true,
    sourceBound: true,
    resultFactBound: true,
    failureDisclosed: true,
  };
  if (!checks.candidatePresent) reasonCodes.push("candidate_empty");
  if (!checks.toolFactsTerminal) reasonCodes.push("weather_tool_fact_incomplete");

  const successfulCalls = toolCalls.filter(isSuccessfulWeatherCall);
  const failedCalls = toolCalls.filter(isFailedToolCall);
  if (successfulCalls.length === 0 && failedCalls.length === 0) {
    reasonCodes.push("weather_tool_result_missing");
  }

  for (const toolCall of successfulCalls) {
    const data = toolCall.output.data;
    if (data?.schemaVersion !== "weather.v1") {
      reasonCodes.push("weather_schema_unsupported");
      continue;
    }
    const locationBound = includesAnyEvidence(content, collectLocationTokens(data));
    const dataTimeBound = includesAnyEvidence(content, collectTimeTokens(data));
    const sourceBound = includesAnyEvidence(content, collectSourceTokens(data));
    const resultFactBound = includesAnyEvidence(content, collectWeatherFactTokens(data));
    checks.locationBound = checks.locationBound && locationBound;
    checks.dataTimeBound = checks.dataTimeBound && dataTimeBound;
    checks.sourceBound = checks.sourceBound && sourceBound;
    checks.resultFactBound = checks.resultFactBound && resultFactBound;
  }

  if (successfulCalls.length > 0) {
    if (!checks.locationBound) reasonCodes.push("weather_location_missing");
    if (!checks.dataTimeBound) reasonCodes.push("weather_data_time_missing");
    if (!checks.sourceBound) reasonCodes.push("weather_source_missing");
    if (!checks.resultFactBound) reasonCodes.push("weather_result_fact_missing");
  }

  if (failedCalls.length > 0) {
    checks.failureDisclosed = disclosesWeatherFailure(content) && !claimsMeasuredTemperature(content);
    if (!checks.failureDisclosed) reasonCodes.push("weather_failure_not_disclosed");
  }

  return createAcceptanceResult({
    policy: WEATHER_POLICY.policy,
    policyVersion: WEATHER_POLICY.policyVersion,
    status: reasonCodes.length === 0 ? "accepted" : "rejected",
    reasonCodes: reasonCodes.length === 0
      ? [successfulCalls.length > 0 ? "weather_evidence_bound" : "weather_failure_disclosed"]
      : [...new Set(reasonCodes)],
    evidence: {
      ...buildToolEvidence(toolCalls),
      checks,
    },
  });
}

/** 判断工具事实已经进入不会继续变化的 completed 或 failed 状态。 */
function isTerminalToolCall(toolCall) {
  return toolCall?.status === "completed" || toolCall?.status === "failed";
}

/** 判断工具事实是带 weather.v1 数据的成功结果。 */
function isSuccessfulWeatherCall(toolCall) {
  return toolCall?.status === "completed" && toolCall?.output?.status === "success";
}

/** 判断工具事实已经以公开错误收口。 */
function isFailedToolCall(toolCall) {
  return toolCall?.status === "failed";
}

/** 收集用户查询和解析后地点名称作为答案绑定候选。 */
function collectLocationTokens(data) {
  return compactEvidenceTokens([
    data?.query?.location,
    data?.location?.name,
    [data?.location?.admin1, data?.location?.name].filter(Boolean).join(""),
  ]);
}

/** 收集观测、数据读取和目标日期的多种公开时间写法。 */
function collectTimeTokens(data) {
  const values = [data?.observedAt, data?.source?.retrievedAt, data?.forecast?.date];
  const tokens = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text) continue;
    tokens.push(text, text.replace("T", " "));
    const date = text.match(/^\d{4}-\d{2}-\d{2}/u)?.[0];
    const time = text.match(/(?:T|\s)(\d{2}:\d{2})/u)?.[1];
    if (date) tokens.push(date);
    if (time) tokens.push(time);
  }
  return compactEvidenceTokens(tokens);
}

/** 收集 Connector 声明的数据来源名称。 */
function collectSourceTokens(data) {
  return compactEvidenceTokens([data?.source?.name]);
}

/** 收集带领域单位或天气语义的结果值，避免仅凭任意数字误判事实绑定。 */
function collectWeatherFactTokens(data) {
  const forecast = data?.forecast || {};
  return compactEvidenceTokens([
    forecast?.condition?.label,
    ...temperatureTokens(forecast?.temperature?.current),
    ...temperatureTokens(forecast?.temperature?.apparent),
    ...temperatureTokens(forecast?.temperature?.min),
    ...temperatureTokens(forecast?.temperature?.max),
    ...unitTokens(forecast?.precipitation?.current, ["mm", "毫米"]),
    ...unitTokens(forecast?.precipitation?.sum, ["mm", "毫米"]),
    ...unitTokens(forecast?.precipitation?.probabilityMax, ["%"]),
    ...unitTokens(forecast?.humidity, ["%"]),
    ...unitTokens(forecast?.windSpeedMax, ["km/h", "公里/小时", "千米/小时"]),
    ...unitTokens(forecast?.windSpeedCurrent, ["km/h", "公里/小时", "千米/小时"]),
  ]);
}

/** 将温度数值扩展为常见中文和符号单位写法。 */
function temperatureTokens(value) {
  return unitTokens(value, ["°c", "℃", "度", "摄氏度"]);
}

/** 将有限数值和允许单位组合成可比较证据 token。 */
function unitTokens(value, units) {
  if (value === null || value === undefined || String(value).trim() === "") return [];
  const number = Number(value);
  if (!Number.isFinite(number)) return [];
  return units.flatMap(
    /** 同时接受有空格和无空格的标准单位表达。 */
    (unit) => [`${number}${unit}`, `${number} ${unit}`],
  );
}

/** 判断候选正文明确说明天气查询没有成功。 */
function disclosesWeatherFailure(content) {
  return ["失败", "未能", "无法", "未返回", "暂时不可用", "查询异常", "稍后重试"].some(
    /** 任一稳定失败表达即可证明没有把工具失败伪装为实时结果。 */
    (token) => content.includes(normalizeEvidenceText(token)),
  );
}

/** 检测工具失败回答中不应出现的实测温度声明。 */
function claimsMeasuredTemperature(content) {
  return /-?\d+(?:\.\d+)?\s*(?:°c|℃|度|摄氏度)/u.test(content);
}

/** 判断规范化候选正文是否包含任一非空事实 token。 */
function includesAnyEvidence(content, tokens) {
  return tokens.length > 0 && tokens.some(
    /** 使用相同规范化规则比较来源、时间和领域结果。 */
    (token) => content.includes(normalizeEvidenceText(token)),
  );
}

/** 清理空值并去重，保持证据候选顺序稳定。 */
function compactEvidenceTokens(values) {
  return [...new Set(values.map(normalizeEvidenceText).filter(Boolean))];
}

/** 统一大小写、空白、破折号和温度符号，降低格式差异造成的误拒绝。 */
function normalizeEvidenceText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

/** 构造不复制 ToolResult 正文的最小验收证据。 */
function buildToolEvidence(toolCalls) {
  return {
    toolCallIds: toolCalls.map(readToolCallId).filter(Boolean),
    toolNames: [...new Set(toolCalls.map(readToolName).filter(Boolean))],
    sources: [...new Set(toolCalls.map(readToolSource).filter(Boolean))],
    observedAt: [...new Set(toolCalls.map(readToolObservedAt).filter(Boolean))],
  };
}

/** 返回工具调用的稳定 provider 调用 ID。 */
function readToolCallId(toolCall) {
  return String(toolCall?.toolCallId || "");
}

/** 返回工具调用的稳定平台工具名。 */
function readToolName(toolCall) {
  return String(toolCall?.toolName || "");
}

/** 返回工具结果声明的数据来源。 */
function readToolSource(toolCall) {
  return String(toolCall?.source || "");
}

/** 返回工具结果声明的数据时间。 */
function readToolObservedAt(toolCall) {
  return String(toolCall?.observedAt || "");
}

/** 创建字段稳定且不携带模型候选正文的验收结果。 */
function createAcceptanceResult({ policy, policyVersion, status, reasonCodes, evidence }) {
  return {
    policy,
    policyVersion,
    status,
    reasonCodes,
    evidence,
    evaluatedAt: new Date().toISOString(),
  };
}
