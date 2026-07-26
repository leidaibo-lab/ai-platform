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

  return {
    baseUrl: baseUrlWithoutVersion,
    gatewayBaseUrl: `${baseUrlWithoutVersion}/v1`,
    model: modelAlias,

    /**
     * 探测模型网关是否可访问，并返回页面展示所需的连接元数据。
     *
     * @returns {Promise<object>} 网关健康状态、地址和模型别名。
     */
    async status() {
      try {
        const response = await fetchImplementation(`${baseUrlWithoutVersion}/v1/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(5000),
        });
        return {
          ok: response.ok,
          status: response.status,
          gatewayBaseUrl: `${baseUrlWithoutVersion}/v1`,
          model: modelAlias,
        };
      } catch (error) {
        return {
          ok: false,
          gatewayBaseUrl: `${baseUrlWithoutVersion}/v1`,
          model: modelAlias,
          error: error.message,
        };
      }
    },

    /**
     * 让 LiteLLM 根据实际模型别名计算完整消息 token；端点不可用时由 Runtime 回退本地估算。
     *
     * @param {object} input - 待计数消息。
     * @param {Array<object>} input.messages - OpenAI-compatible 消息列表。
     * @returns {Promise<{tokens: number, source: string, model: string}>} 网关计数结果。
     */
    async countTokens({ messages }) {
      if (!tokenCounterSupported) throw new Error("LiteLLM token counter is unavailable");
      let data;
      try {
        data = await requestJson("/utils/token_counter", {
          method: "POST",
          body: { model: modelAlias, messages },
          timeoutMs: 10000,
        });
      } catch (error) {
        if (error?.status === 404 || error?.status === 405) tokenCounterSupported = false;
        throw error;
      }
      const tokens = Number(data?.total_tokens ?? data?.token_count ?? data?.tokens);
      if (!Number.isFinite(tokens)) throw new Error("Model gateway did not return a token count");
      return { tokens, source: "litellm", model: data?.model || modelAlias };
    },
  };
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
