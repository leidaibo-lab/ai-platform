/**
 * Runtime 依赖的模型网关客户端端口。实现只拥有调用协议，不拥有会话或上游 provider key。
 *
 * @typedef {object} GatewayClient
 * @property {string} baseUrl - LiteLLM Proxy 根地址。
 * @property {string} gatewayBaseUrl - 对外 OpenAI-compatible 基础地址。
 * @property {string} model - Runtime 使用的模型别名。
 * @property {string} imageModel - Runtime 使用的图片模型别名。
 * @property {string} imageEditModel - Runtime 使用的 Responses 图片编辑模型别名。
 * @property {{"conversation.chat": string, "image.generate": string, "image.edit": string}} defaultModels - 每种稳定 operation 的服务端默认别名。
 * @property {{chat: string[], vision: string[], imageGeneration: string[], imageEditing: string[]}} modelCapabilities - 服务端声明的稳定模型能力策略。
 * @property {() => Promise<object>} status - LiteLLM 状态探测。
 * @property {(options?: object) => Promise<string[]>} listModels - 当前 key 可见的模型别名。
 * @property {(requestedModel?: string) => Promise<string>} resolveModel - 解析并校验单次 Run 模型别名。
 * @property {(requestedModel?: string, requirements?: {requiresVision?: boolean}) => Promise<string>} resolveConversationModel - 按纯文本或视觉对话能力解析模型别名。
 * @property {(requestedModel?: string, operation?: string) => Promise<string>} resolveImageModel - 按图片生成或编辑能力解析模型别名。
 * @property {(input: object) => Promise<object>} chatCompletions - 模型生成调用。
 * @property {(input: object) => Promise<object>} generateImages - 图片模型生成调用。
 * @property {(input: object) => Promise<object>} editImages - 图片模型编辑调用。
 * @property {(input: object) => Promise<object>} countTokens - LiteLLM token counter 调用。
 */

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
    this.retryAfterMs = null;
    this.retryable = null;
    this.resilience = null;
  }
}
