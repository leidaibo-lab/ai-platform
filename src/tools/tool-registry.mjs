export function createToolRegistry(tools = []) {
  const registry = new Map();

  for (const tool of tools) {
    if (!tool?.name) continue;
    registry.set(tool.name, tool);
  }

  return {
    list() {
      return [...registry.values()].map(({ name, description }) => ({ name, description }));
    },

    get(name) {
      return registry.get(name) || null;
    },

    resolveToolIntent() {
      return {
        needed: false,
        toolName: null,
        reason: "No tool loop is enabled in the current V0.5 runtime.",
      };
    },
  };
}
