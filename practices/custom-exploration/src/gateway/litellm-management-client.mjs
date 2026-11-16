import { GatewayRequestError } from "./gateway-contract.mjs";

/**
 * 创建 LiteLLM 专属管理客户端，仅负责 AI SDK 未覆盖的状态与 token 计数端点。
 *
 * @param {object} options - 模型网关连接配置。
 * @param {string} options.baseUrl - LiteLLM Proxy 基础地址。
 * @param {string} options.model - 对外使用的模型别名。
 * @param {string} options.apiKey - LiteLLM 访问密钥。
 * @param {typeof fetch} [options.fetchImplementation] - 可选 fetch 注入，供协议测试使用。
 * @returns {object} LiteLLM 管理能力。
 */
export function createLiteLlmManagementClient({ baseUrl, model, apiKey, fetchImplementation = fetch }) {
  const baseUrlWithoutVersion = trimTrailingSlash(baseUrl || "http://localhost:4000");
  const modelAlias = model || "chat-default";
  const key = apiKey || "sk-local-admin-key";
  let tokenCounterSupported = true;
  let cachedModelAliases = null;

  /** 统一执行带鉴权、超时和错误映射的 LiteLLM JSON 管理请求。 */
  async function requestJson(path, { method = "GET", body, timeoutMs = 120000 } = {}) {
    const response = await fetchImplementation(`${baseUrlWithoutVersion}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    const data = parseJson(text);
    if (!response.ok) {
      throw new GatewayRequestError(
        data?.error?.message || data?.error || "Gateway request failed",
        response.status,
        data,
      );
    }
    return data;
  }

  /** 读取当前 LiteLLM key 可见的模型别名，并缓存供同一进程内的 Run 校验。 */
  async function listModels({ forceRefresh = false } = {}) {
    if (!forceRefresh && cachedModelAliases) return [...cachedModelAliases];
    const data = await requestJson("/v1/models", { timeoutMs: 5000 });
    const aliases = normalizeModelAliases(data?.data);
    cachedModelAliases = aliases;
    return [...aliases];
  }

  /** 解析单次 Run 的模型别名；默认别名保持兼容，其他别名必须由网关目录确认。 */
  async function resolveModel(requestedModel) {
    const candidate = String(requestedModel || modelAlias).trim() || modelAlias;
    if (candidate === modelAlias) return candidate;
    const aliases = await listModels();
    if (aliases.includes(candidate)) return candidate;
    throw new GatewayRequestError("Unsupported model alias", 400, {
      error: "Unsupported model alias",
      code: "unsupported_model",
      model: candidate,
    });
  }

  return {
    baseUrl: baseUrlWithoutVersion,
    gatewayBaseUrl: `${baseUrlWithoutVersion}/v1`,
    model: modelAlias,
    listModels,
    resolveModel,

    /**
     * 探测 LiteLLM `/v1/models` 是否可访问，并返回页面展示所需的可达性元数据。
     *
     * @returns {Promise<object>} 网关可达状态、地址和模型别名；不代表上游生成能力。
     */
    async status() {
      try {
        const models = await listModels({ forceRefresh: true });
        return {
          ok: true,
          status: 200,
          gatewayBaseUrl: `${baseUrlWithoutVersion}/v1`,
          model: modelAlias,
          models,
        };
      } catch (error) {
        return {
          ok: false,
          status: Number(error?.status) || undefined,
          gatewayBaseUrl: `${baseUrlWithoutVersion}/v1`,
          model: modelAlias,
          models: cachedModelAliases ? [...cachedModelAliases] : [],
          error: error.message,
        };
      }
    },

    /**
     * 让 LiteLLM 根据实际模型别名计算完整消息 token；端点不可用时由 Runtime 回退本地估算。
     *
     * @param {object} input - 待计数消息。
     * @param {Array<object>} input.messages - OpenAI-compatible 消息列表。
     * @param {number} [input.deadlineAt] - 当前 Run 共享的绝对截止时间。
     * @returns {Promise<{tokens: number, source: string, model: string}>} 网关计数结果。
     */
    async countTokens({ messages, deadlineAt, model: requestedModel }) {
      if (!tokenCounterSupported) throw new Error("LiteLLM token counter is unavailable");
      const selectedModel = await resolveModel(requestedModel);
      let data;
      try {
        data = await requestJson("/utils/token_counter", {
          method: "POST",
          body: { model: selectedModel, messages },
          timeoutMs: calculateRequestTimeout(deadlineAt, 10000),
        });
      } catch (error) {
        if (error?.status === 404 || error?.status === 405) tokenCounterSupported = false;
        throw error;
      }
      const tokens = Number(data?.total_tokens ?? data?.token_count ?? data?.tokens);
      if (!Number.isFinite(tokens)) throw new Error("Model gateway did not return a token count");
      return { tokens, source: "litellm", model: data?.model || selectedModel };
    },
  };
}

/** 将 `/v1/models` 数据整理为去重别名列表，空目录保持为空以反映真实授权结果。 */
function normalizeModelAliases(items) {
  const aliases = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const alias = String(item?.id || "").trim();
    if (alias && !seen.has(alias)) {
      seen.add(alias);
      aliases.push(alias);
    }
  }
  return aliases;
}

/** 让管理请求服从 Run 剩余时间，同时保留自身较短的超时上限。 */
function calculateRequestTimeout(deadlineAt, fallbackMs) {
  if (!Number.isFinite(deadlineAt)) return fallbackMs;
  return Math.max(1, Math.min(fallbackMs, Math.floor(deadlineAt - Date.now())));
}

/** 尝试解析网关响应；非 JSON 内容保留为 error 字段以便上层展示真实错误。 */
function parseJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return { error: value };
  }
}

/** 统一基础地址格式，避免后续路径拼接出现双斜杠。 */
function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}
