export class GatewayRequestError extends Error {
  /**
   * 保存模型网关返回的 HTTP 状态和响应数据，供上层适配为渠道错误响应。
   *
   * @param {string} message - 可读错误信息。
   * @param {number} status - 模型网关 HTTP 状态码。
   * @param {unknown} data - 模型网关响应数据。
   */
  constructor(message, status, data) {
    super(message);
    this.name = "GatewayRequestError";
    this.status = status;
    this.data = data;
  }
}

/**
 * 创建封装 LiteLLM 模型查询和对话请求的网关客户端。
 *
 * @param {object} options - 模型网关连接配置。
 * @param {string} options.baseUrl - LiteLLM Proxy 基础地址。
 * @param {string} options.model - 对外使用的模型别名。
 * @param {string} options.apiKey - LiteLLM 访问密钥。
 * @returns {object} 供 Runtime 使用的模型网关客户端。
 */
export function createLiteLlmClient({ baseUrl, model, apiKey }) {
  const gatewayBaseUrl = trimTrailingSlash(baseUrl || "http://localhost:4000");
  const modelAlias = model || "chat-default";
  const key = apiKey || "sk-local-admin-key";
  let tokenCounterSupported = true;

  // 统一执行带鉴权、超时和错误映射的 LiteLLM JSON 请求。
  async function requestJson(path, { method = "GET", body, timeoutMs = 120000 } = {}) {
    const response = await fetch(`${gatewayBaseUrl}${path}`, {
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
    baseUrl: gatewayBaseUrl,
    gatewayBaseUrl: `${gatewayBaseUrl}/v1`,
    model: modelAlias,

    /**
     * 探测模型网关是否可访问，并返回页面展示所需的连接元数据。
     *
     * @returns {Promise<object>} 网关健康状态、地址和模型别名。
     */
    async status() {
      try {
        const response = await fetch(`${gatewayBaseUrl}/v1/models`, {
          headers: {
            Authorization: `Bearer ${key}`,
          },
          signal: AbortSignal.timeout(5000),
        });

        return {
          ok: response.ok,
          status: response.status,
          gatewayBaseUrl: `${gatewayBaseUrl}/v1`,
          model: modelAlias,
        };
      } catch (error) {
        return {
          ok: false,
          gatewayBaseUrl: `${gatewayBaseUrl}/v1`,
          model: modelAlias,
          error: error.message,
        };
      }
    },

    /**
     * 将 Runtime 构造的消息转发到 LiteLLM Chat Completions 接口。
     *
     * @param {object} input - 对话请求参数。
     * @param {Array<object>} input.messages - OpenAI-compatible 消息列表。
     * @param {number} [input.temperature] - 可选采样温度。
     * @param {number} [input.maxCompletionTokens] - 模型输出硬上限。
     * @param {object} [input.responseFormat] - 可选结构化输出约束。
     * @returns {Promise<object>} LiteLLM 返回的原始对话结果。
     */
    chatCompletions({ messages, temperature, maxCompletionTokens, responseFormat }) {
      return requestJson("/v1/chat/completions", {
        method: "POST",
        body: {
          model: modelAlias,
          messages,
          ...(temperature === undefined ? {} : { temperature }),
          ...(maxCompletionTokens === undefined ? {} : { max_completion_tokens: maxCompletionTokens }),
          ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
        },
      });
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

// 尝试解析网关响应；非 JSON 内容保留为 error 字段以便上层展示真实错误。
function parseJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return { error: value };
  }
}

// 统一基础地址格式，避免后续路径拼接出现双斜杠。
function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}
