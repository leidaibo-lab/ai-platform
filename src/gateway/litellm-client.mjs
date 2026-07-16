export class GatewayRequestError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = "GatewayRequestError";
    this.status = status;
    this.data = data;
  }
}

export function createLiteLlmClient({ baseUrl, model, apiKey }) {
  const gatewayBaseUrl = trimTrailingSlash(baseUrl || "http://localhost:4000");
  const modelAlias = model || "chat-default";
  const key = apiKey || "sk-local-admin-key";

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

    chatCompletions({ messages, temperature }) {
      return requestJson("/v1/chat/completions", {
        method: "POST",
        body: {
          model: modelAlias,
          messages,
          ...(temperature === undefined ? {} : { temperature }),
        },
      });
    },
  };
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return { error: value };
  }
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}
