/**
 * 使用注册表模式按名称管理工具，并隔离 Runtime 与具体连接器实现。
 *
 * @param {Array<object>} [tools] - 带 name 和 description 的工具定义。
 * @returns {object} 工具查询和意图判断接口。
 */
export function createToolRegistry(tools = []) {
  const registry = new Map();

  for (const tool of tools) {
    if (!tool?.name) continue;
    registry.set(tool.name, tool);
  }

  return {
    /**
     * 返回可公开展示的工具元数据，不暴露工具执行实现。
     *
     * @returns {Array<{name: string, description: string}>} 工具名称和说明列表。
     */
    list() {
      // 从内部工具定义中挑选渠道可见字段。
      return [...registry.values()].map(({ name, description }) => ({ name, description }));
    },

    /**
     * 按名称查询完整工具定义，未注册时返回 null。
     *
     * @param {string} name - 工具名称。
     * @returns {object|null} 完整工具定义。
     */
    get(name) {
      return registry.get(name) || null;
    },

    /**
     * 明确当前版本不启用真实工具循环，为后续连接器接入保留稳定边界。
     *
     * @returns {{needed: false, toolName: null, reason: string}} 当前工具意图结果。
     */
    resolveToolIntent() {
      return {
        needed: false,
        toolName: null,
        reason: "No tool loop is enabled in the current V0.5 runtime.",
      };
    },
  };
}
