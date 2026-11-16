const DEFAULT_CONTEXT_OPTIONS = {
  maxContextTokens: 12000,
  reservedOutputTokens: 2000,
  safetyTokens: 500,
  highWatermarkRatio: 0.75,
  lowWatermarkRatio: 0.45,
  hardWatermarkRatio: 0.9,
};

/**
 * 合并上下文预算默认值，并校验高低水位之间的顺序关系。
 *
 * @param {object} [contextOptions] - 调用方提供的预算覆盖项。
 * @returns {object} 可直接用于上下文规划的完整配置。
 */
export function normalizeContextOptions(contextOptions = {}) {
  const options = {
    ...DEFAULT_CONTEXT_OPTIONS,
    ...pickPositiveNumbers(contextOptions),
  };

  if (!(options.lowWatermarkRatio < options.highWatermarkRatio)) {
    throw new TypeError("lowWatermarkRatio must be lower than highWatermarkRatio");
  }
  if (!(options.highWatermarkRatio < options.hardWatermarkRatio && options.hardWatermarkRatio <= 1)) {
    throw new TypeError("hardWatermarkRatio must be greater than highWatermarkRatio and no greater than 1");
  }
  if (options.reservedOutputTokens + options.safetyTokens >= options.maxContextTokens) {
    throw new TypeError("reserved output and safety tokens must leave a positive input budget");
  }

  return options;
}

/**
 * 计算模型输入上限和动态会话的高、低、硬水位。
 *
 * @param {object} contextOptions - 上下文预算配置。
 * @param {number} [fixedInputTokens=0] - 系统规则、当前输入等固定 token。
 * @returns {{inputBudget: number, dynamicBudget: number, high: number, low: number, hard: number}} 水位结果。
 */
export function calculateContextThresholds(contextOptions, fixedInputTokens = 0) {
  const options = normalizeContextOptions(contextOptions);
  const inputBudget = options.maxContextTokens - options.reservedOutputTokens - options.safetyTokens;
  const dynamicBudget = Math.max(0, inputBudget - Math.max(0, fixedInputTokens));

  return {
    inputBudget,
    dynamicBudget,
    high: Math.floor(dynamicBudget * options.highWatermarkRatio),
    low: Math.floor(dynamicBudget * options.lowWatermarkRatio),
    hard: Math.floor(dynamicBudget * options.hardWatermarkRatio),
  };
}

/**
 * 估算一组 OpenAI-compatible 消息的 token 总量。
 *
 * @param {Array<object>} messages - 待估算的消息列表。
 * @returns {number} 本地保守估算 token。
 */
export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const message of messages || []) {
    total += estimateMessageTokens(message);
  }
  return total;
}

/**
 * 估算单条文本或多模态消息占用的 token。
 *
 * @param {object} message - OpenAI-compatible 消息。
 * @returns {number} 本地保守估算 token。
 */
export function estimateMessageTokens(message) {
  const roleTokens = 4;
  if (Array.isArray(message?.content)) {
    let total = roleTokens;
    for (const part of message.content) {
      total += part?.type === "image_url" ? 260 : estimateTokens(String(part?.text || ""));
    }
    return total;
  }

  return roleTokens + estimateTokens(String(message?.content || ""));
}

/**
 * 使用字符密度近似文本 token，作为模型网关精确计数不可用时的回退。
 *
 * @param {unknown} value - 待估算文本。
 * @returns {number} 向上取整的估算 token。
 */
export function estimateTokens(value) {
  return Math.ceil(String(value || "").length / 2);
}

/**
 * 从任意配置对象中挑选有限正数，阻止无效值覆盖默认预算。
 *
 * @param {object} value - 待筛选配置。
 * @returns {Record<string, number>} 只包含有限正数的配置副本。
 */
function pickPositiveNumbers(value) {
  const result = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (Number.isFinite(item) && item > 0) result[key] = item;
  }
  return result;
}
