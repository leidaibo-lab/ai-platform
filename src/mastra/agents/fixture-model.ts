import { MastraLanguageModelV2Mock, createMockModel } from '@mastra/core/test-utils/llm-mock';

/** 固定样例只验证框架控制流；不作为模型质量、代码运行或部署证据。 */
const drafts: Record<string, string> = {
  reading: '这是固定样例阅读助手（fixture）。当前文档描述标题长度及空白校验；请重点检查边界、计数口径和异常反馈。此回复未作真实需求推理，也没有修改正文或提交审阅决定。',
  product: '# 产品交接样例（fixture）\n需求：工单标题去首尾空格后为 1–80 字符。\n验收：空白拒绝，长度边界通过，超长拒绝。\n此为固定样例，真实需求须使用 live 模式并人工确认。',
  'product-analysis': '# 需求分析（fixture）\n提取目标、用户、场景、约束、范围和待决事项；未执行审批。',
  'product-clarification': '# 需求梳理（fixture）\n用户诉求：工单标题校验。已给定：去首尾空格、1–80 字符。其他未提供的业务选择交人工确认。',
  'product-scope-priority': '# 范围与优先级（fixture）\n明确首期范围、非目标、优先级和可检查验收边界；不自行补造业务决定。',
  'product-manager': '# 产品经理阶段（fixture）\n本轮由同一个产品经理 Agent 完成需求分析、范围与优先级整理或产品稿写作；固定样例不代表真实业务判断。',
  'product-reviewer': '# 产品独立审查（fixture）\n检查目标、范围、规则、异常流程和验收条件；固定样例不代表真实质量结论，最终仍需人工产品负责人批准。',
  development: '# 代码提案样例（fixture，未执行）\n```ts\n/** 校验工单标题的长度边界。 */\nexport function validTitle(title: string): boolean {\n  const length = title.trim().length;\n  return length >= 1 && length <= 80;\n}\n```\n开发需审查需求一致性、字符计数口径和错误处理；未创建分支或执行构建。',
  testing: '# 测试计划样例（fixture，未执行）\n需求映射：标题长度→空串、空白、1、80、81 字符；去空格→前后空格。\n尚缺：Unicode 计数口径、接口集成、实际运行报告。\n测试人员确认的是计划覆盖，不能视为测试通过。',
  operations: '# 部署方案样例（fixture，未执行）\n前提：明确代码提交、构建制品、环境与权限。\n步骤：CI 检查→预发部署→健康探测→人工授权后发布。\n回滚：保留上一制品，探测失败立即切回并复验。\n当前无制品、无部署执行，运维确认只针对方案。',
};

/** 同步和流式入口共用相同工具决定，避免 Studio 与脚本行为不同。 */
function minimalResponse(prompt: readonly { role: string }[]) {
  // 原生工具结果进入上下文后才能生成终答。
  const hasResult = prompt.some((message) => message.role === 'tool');
  return {
    content: hasResult
      ? [{ type: 'text' as const, text: 'Mastra 原生 Agent 已读取 practiceInfo：这是独立学习应用，未执行部署。（fixture）' }]
      : [{ type: 'tool-call' as const, toolCallId: 'fixture-info-1', toolName: 'practiceInfo', input: '{}' }],
    finishReason: hasResult ? 'stop' as const : 'tool-calls' as const,
    usage: { inputTokens: 12, outputTokens: 20, totalTokens: 32 },
    warnings: [],
  };
}

/** 使用官方 Mock 驱动原生 Agent；minimal 强制一次只读工具调用。 */
export function createFixtureModel(stage: string) {
  if (stage === 'testing-workspace') return new MastraLanguageModelV2Mock({
    /** 测试角色先读取候选，再提交固定样例计划。 */
    doGenerate: async options => {
      const messages = JSON.stringify(options.prompt);
      const hasResult = options.prompt.some(message => message.role === 'tool');
      const match = messages.match(/src\/[a-zA-Z0-9_./()\[\]-]+\.(?:mjs|py|ts|tsx|js)/);
      if (!match && !hasResult) throw new Error('fixture测试计划缺少候选源码路径');
      return { content: hasResult ? [{ type: 'text' as const, text: drafts.testing }] : [{ type: 'tool-call' as const, toolCallId: 'fixture-testing-read', toolName: 'mastra_workspace_read_file', input: JSON.stringify({ path: match![0], showLineNumbers: false }) }], finishReason: hasResult ? 'stop' as const : 'tool-calls' as const, usage: { inputTokens: 12, outputTokens: 20, totalTokens: 32 }, warnings: [] };
    },
  });
  // 产品修订固定返回有差异的样例；只验证流程，不模拟理解确认结论。
  if (stage === 'product' || stage.startsWith('product-')) {
    /** 普通生成和修订共享固定样例，任务标记只决定是否显示修订段落。 */
    function productText(prompt: unknown) {
      const serialized = JSON.stringify(prompt);
      if (serialized.includes('只使用两个一级标题')) {
        const expected = serialized.includes('revision-task') ? '修订版检查返回 1' : '登记检查返回 1';
        return `# 需求文档\n\n## 固定样例\n- REQ-FIXTURE-A: 固定模块返回声明值 | 验收: ${expected}\n\n### Scenario: 验证模块输出\n- **WHEN** 执行登记检查\n- **THEN** ${expected}\n\n# 产品规格\n\n- TASK-FIXTURE-MODULES: 实现固定模块并通过登记检查 | 需求: REQ-FIXTURE-A`;
      }
      const requirements = serialized.includes('REQ-APPLICATION-SUBMIT')
        ? `\n\n## 可验收需求\n- REQ-FIXTURE-A: 固定模块返回声明值 | 验收: ${serialized.includes('revision-task') ? '修订版检查返回 1' : '登记检查返回 1'}`
        : '';
      return drafts[stage] + requirements + (serialized.includes('revision-task') ? '\n\n## 修订样例（fixture）\n此为修订流程固定输出；具体结论须由人工检查，不代表模型理解或确认。' : '') + (serialized.includes('sourceContent') ? '\n\n返工样例（fixture）：已进入带来源和反馈的新轮次；此固定文本不代表理解或解决反馈。' : '');
    }
    /** 固定产品角色在提供工作区路径时读取资料，再输出样例。 */
    function productResponse(prompt: readonly { role: string }[]) {
      const serialized = JSON.stringify(prompt);
      const workspacePath = serialized.match(/workspaceFile\\?"\s*:\s*\\?"([^"\\]+)/)?.[1];
      const hasWorkspaceRead = serialized.includes('fixture-workspace-read');
      const call = workspacePath && !hasWorkspaceRead ? { type: 'tool-call' as const, toolCallId: 'fixture-workspace-read', toolName: 'mastra_workspace_read_file', input: JSON.stringify({ path: workspacePath, showLineNumbers: false }) } : undefined;
      return {
        content: call ? [call] : [{ type: 'text' as const, text: productText(prompt) }],
        finishReason: call ? 'tool-calls' as const : 'stop' as const,
        usage: { inputTokens: 12, outputTokens: 20, totalTokens: 32 }, warnings: [],
      };
    }
    return new MastraLanguageModelV2Mock({
      // 同步入口交给 Mastra 消费固定文本，不访问远程模型。
      doGenerate: async (options) => productResponse(options.prompt),
      // 保留产品 Agent 在 Studio 中的原生 stream 能力。
      doStream: async (options) => ({ stream: new ReadableStream({
        // 仅发送固定文本协议；不把测试样例写成真实推理证据。
        start(controller) {
          const response = productResponse(options.prompt);
          controller.enqueue({ type: 'stream-start', warnings: [] });
          const content = response.content[0];
          if (content.type === 'tool-call') controller.enqueue(content);
          else {
            controller.enqueue({ type: 'text-start', id: 'fixture-product' });
            controller.enqueue({ type: 'text-delta', id: 'fixture-product', delta: content.text });
            controller.enqueue({ type: 'text-end', id: 'fixture-product' });
          }
          controller.enqueue({ type: 'finish', finishReason: response.finishReason, usage: response.usage });
          controller.close();
        },
      }) }),
    });
  }
  if (stage !== 'minimal') return createMockModel({ mockText: drafts[stage] ?? 'fixture', version: 'v2' });
  return new MastraLanguageModelV2Mock({
    // 根据已执行工具结果返回终答，让 Mastra 自己完成工具循环。
    doGenerate: async (options) => minimalResponse(options.prompt),
    // 为 Studio 的流式聊天提供相同协议，不访问任何远程模型。
    doStream: async (options) => {
      const response = minimalResponse(options.prompt);
      return { stream: new ReadableStream({
        // 按 AI SDK v2 协议发送工具调用或文本及终态，交由 Mastra 执行。
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          const content = response.content[0];
          if (content.type === 'tool-call') controller.enqueue(content);
          else {
            controller.enqueue({ type: 'text-start', id: 'fixture-text' });
            controller.enqueue({ type: 'text-delta', id: 'fixture-text', delta: content.text });
            controller.enqueue({ type: 'text-end', id: 'fixture-text' });
          }
          controller.enqueue({ type: 'finish', finishReason: response.finishReason, usage: response.usage });
          controller.close();
        },
      }) };
    },
  });
}
