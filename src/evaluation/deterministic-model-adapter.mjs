/**
 * 创建 OpenAI-compatible 固定行为模型 Fetch Adapter。
 *
 * Adapter 只把标准模型请求转换为场景决策；场景模块必须根据当前请求中的持久化观察结果
 * 决定返回 Tool Call 或正文，不得依赖调用轮次等 Runner 隐式状态。
 *
 * @param {object} input - 固定模型配置。
 * @param {object} input.scenario - 已加载的 Runtime 场景。
 * @param {string} [input.modelAlias] - 当前 Run 需要持久化的模型别名。
 * @returns {typeof fetch} 可注入现有 GatewayClient 的 Fetch Port。
 */
export function createDeterministicModelFetch({ scenario, modelAlias }) {
  const definition = scenario.definition;
  const visibleModelAlias = String(modelAlias || definition.deterministicModel.alias).trim();

  /** 处理模型目录、token counter 和 chat completions 三类兼容请求。 */
  async function deterministicFetch(input, init = {}) {
    const request = await readRequest(input, init);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/v1/models") {
      return jsonResponse({ data: [{ id: visibleModelAlias }] });
    }
    if (pathname === "/utils/token_counter") {
      return jsonResponse({
        total_tokens: estimateMessagesTokens(request.body?.messages),
        model: definition.deterministicModel.actualModel,
      });
    }
    if (pathname === "/v1/chat/completions") {
      assertEvaluationParameters(request.body, definition.evaluation);
      const decision = await scenario.deterministicModel.decide({
        model: request.body?.model,
        messages: Array.isArray(request.body?.messages) ? request.body.messages : [],
        tools: Array.isArray(request.body?.tools) ? request.body.tools : [],
        toolChoice: request.body?.tool_choice,
      });
      return jsonResponse(buildChatCompletion(definition, decision));
    }
    return jsonResponse({ error: { message: "unsupported deterministic model endpoint" } }, 404);
  }

  return deterministicFetch;
}

/** 校验版本化生成参数确实进入模型请求，避免报告声明与实际调用漂移。 */
function assertEvaluationParameters(requestBody, expected) {
  if (requestBody?.temperature !== expected.temperature) {
    throw new Error("scenario temperature was not applied to the model request");
  }
  if (requestBody?.max_completion_tokens !== expected.maxCompletionTokens) {
    throw new Error("scenario maxCompletionTokens was not applied to the model request");
  }
}

/** 从原生 Request 或 Fetch init 中读取 URL 与 JSON 请求体。 */
async function readRequest(input, init) {
  const url = input instanceof Request ? input.url : String(input);
  const rawBody = input instanceof Request ? await input.clone().text() : String(init.body || "");
  return {
    url,
    body: rawBody ? JSON.parse(rawBody) : null,
  };
}

/** 把场景决策映射为标准 OpenAI-compatible chat completion。 */
function buildChatCompletion(definition, decision) {
  if (!decision || typeof decision !== "object") throw new TypeError("deterministic model decision is required");
  const model = String(decision.model || definition.deterministicModel.actualModel);
  const usage = normalizeUsage(decision.usage);
  if (decision.type === "tool-call") {
    const toolCall = decision.toolCall;
    if (!toolCall?.id || !toolCall?.name || !toolCall?.input) {
      throw new TypeError("tool-call decision requires id, name, and input");
    }
    return {
      id: `scenario-${definition.id}-tool`,
      object: "chat.completion",
      created: 1720000000,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: String(toolCall.id),
                type: "function",
                function: {
                  name: String(toolCall.name),
                  arguments: JSON.stringify(toolCall.input),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage,
    };
  }
  if (decision.type === "text") {
    return {
      id: `scenario-${definition.id}-text`,
      object: "chat.completion",
      created: 1720000001,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: String(decision.content || "") },
          finish_reason: "stop",
        },
      ],
      usage,
    };
  }
  throw new TypeError(`unsupported deterministic model decision: ${decision.type}`);
}

/** 为固定模型结果生成稳定 usage，允许场景覆盖具体数值。 */
function normalizeUsage(usage) {
  return {
    prompt_tokens: positiveInteger(usage?.prompt_tokens, 24),
    completion_tokens: positiveInteger(usage?.completion_tokens, 8),
    total_tokens: positiveInteger(usage?.total_tokens, 32),
  };
}

/** 将候选值归一化为正整数，无效值使用固定回退。 */
function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** 使用字符长度做稳定 token 近似，避免确定性测试依赖真实管理端点。 */
function estimateMessagesTokens(messages) {
  let characters = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    characters += JSON.stringify(message).length;
  }
  return Math.max(1, Math.ceil(characters / 4));
}

/** 创建标准 JSON Response，供 AI SDK Provider 按真实协议消费。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
