import { jsonSchema, tool } from "ai";
import { z } from "zod";

const TOOL_EXECUTION_CONTEXT_SCHEMA = z
  .object({
    executeTool: z.custom(isToolExecutor),
  })
  .strict();

/**
 * @typedef {object} ToolDefinition
 * @property {string} name - 模型调用使用的稳定工具名。
 * @property {string} title - 渠道展示的公开标题。
 * @property {string} description - 发送给模型的工具用途和边界。
 * @property {"read"} effect - 当前 V1 只允许无副作用只读工具。
 * @property {object} inputSchema - 用于模型参数生成和运行时校验的 Zod/Standard Schema 或 JSON Schema。
 * @property {(input: object, context: object) => Promise<object>} execute - 具体 Connector 执行入口。
 * @property {(input: {message: string}) => boolean} [matchesInput] - 确定性任务路由谓词，命中时强制首步调用该工具。
 * @property {(error: unknown) => {code: string, message: string, retryable: boolean}} [toPublicError] - 工具专属安全错误映射。
 */

/**
 * 使用注册表模式按名称管理服务端 allowlist，并把平台工具定义适配为 AI SDK ToolSet。
 *
 * @param {ToolDefinition[]} [definitions] - 已通过方案决策允许启用的工具定义。
 * @returns {object} 工具目录和 AI SDK 适配接口。
 */
export function createToolRegistry(definitions = []) {
  const registry = new Map();

  for (const definition of definitions) {
    validateToolDefinition(definition);
    registry.set(definition.name, Object.freeze({ ...definition }));
  }

  return {
    /** 返回渠道可公开展示的工具元数据，不暴露执行器和完整 schema。 */
    list() {
      const result = [];
      for (const definition of registry.values()) {
        result.push({
          name: definition.name,
          title: definition.title,
          description: definition.description,
          effect: definition.effect,
        });
      }
      return result;
    },

    /** 按名称查询完整服务端定义，未注册时返回 null。 */
    get(name) {
      return registry.get(name) || null;
    },

    /** 判断当前 Runtime 是否有至少一个允许发送给模型的工具。 */
    hasTools() {
      return registry.size > 0;
    },

    /**
     * 按注册顺序匹配需要确定性执行的工具；未命中时继续由模型自动选择。
     *
     * @param {{message: string}} input - 当前 Run 的原始用户输入。
     * @returns {string|null} 首步必须调用的工具名。
     */
    resolveRequiredTool(input) {
      for (const definition of registry.values()) {
        if (typeof definition.matchesInput === "function" && definition.matchesInput(input)) {
          return definition.name;
        }
      }
      return null;
    },

    /**
     * 将当前 allowlist 转换为 AI SDK ToolSet，并把执行统一交回 Runtime 包装器。
     *
     * @returns {Record<string, object>} 可交给 AI SDK Core 多步生成的工具集合。
     */
    buildAiSdkTools() {
      const tools = {};
      for (const definition of registry.values()) {
        /** 通过 AI SDK `toolsContext` 中的 Runtime 包装器执行已校验的工具调用。 */
        async function execute(input, options) {
          const { context, ...executionOptions } = options || {};
          return context.executeTool(definition, input, executionOptions);
        }
        tools[definition.name] = tool({
          description: definition.description,
          inputSchema: toAiSdkSchema(definition.inputSchema),
          contextSchema: TOOL_EXECUTION_CONTEXT_SCHEMA,
          execute,
        });
      }
      return tools;
    },

    /** 为当前 Run 构造按工具名隔离并由 AI SDK 校验的服务端执行上下文。 */
    buildAiSdkToolsContext(executeTool) {
      if (typeof executeTool !== "function") throw new TypeError("executeTool must be a function");
      const toolsContext = {};
      for (const definition of registry.values()) {
        toolsContext[definition.name] = { executeTool };
      }
      return toolsContext;
    },
  };
}

/** 判断服务端工具上下文是否提供 Runtime 受控执行入口。 */
function isToolExecutor(value) {
  return typeof value === "function";
}

/** 保留 Zod 等 Standard Schema 的本地校验器，并兼容既有原始 JSON Schema 定义。 */
function toAiSdkSchema(schema) {
  return typeof schema?.["~standard"]?.validate === "function" ? schema : jsonSchema(schema);
}

/** 校验服务端工具定义不变量，当前阶段拒绝写工具进入 allowlist。 */
function validateToolDefinition(definition) {
  if (!definition || typeof definition !== "object") throw new TypeError("tool definition must be an object");
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(String(definition.name || ""))) {
    throw new TypeError("tool name must use stable snake_case");
  }
  if (!definition.title || !definition.description) throw new TypeError("tool title and description are required");
  if (definition.effect !== "read") throw new TypeError("only read-only tools are allowed in the current V1 runtime");
  if (!definition.inputSchema || typeof definition.inputSchema !== "object") {
    throw new TypeError("tool inputSchema is required");
  }
  if (typeof definition.execute !== "function") throw new TypeError("tool execute function is required");
  if (definition.matchesInput !== undefined && typeof definition.matchesInput !== "function") {
    throw new TypeError("tool matchesInput must be a function");
  }
}
