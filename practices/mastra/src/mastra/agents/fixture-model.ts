import { MastraLanguageModelV2Mock, createMockModel } from '@mastra/core/test-utils/llm-mock';

/** 固定样例只验证框架控制流；不作为模型质量、代码运行或部署证据。 */
const drafts: Record<string, string> = {
  reading: '这是固定样例阅读助手（fixture）。当前文档描述标题长度及空白校验；请重点检查边界、计数口径和异常反馈。此回复未作真实需求推理，也没有修改正文或提交审阅决定。',
  product: '# 产品交接样例（fixture）\n需求：工单标题去首尾空格后为 1–80 字符。\n验收：空白拒绝，长度边界通过，超长拒绝。\n此为固定样例，真实需求须使用 live 模式并人工确认。',
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
  // 产品修订固定返回有差异的样例；只验证流程，不模拟理解确认结论。
  if (stage === 'product') {
    /** 普通生成和修订共享固定样例，任务标记只决定是否显示修订段落。 */
    function productText(prompt: unknown) {
      return drafts.product + (JSON.stringify(prompt).includes('revision-task') ? '\n\n## 修订样例（fixture）\n此为修订流程固定输出；具体结论须由人工检查，不代表模型理解或确认。' : '');
    }
    return new MastraLanguageModelV2Mock({
      // 同步入口交给 Mastra 消费固定文本，不访问远程模型。
      doGenerate: async (options) => ({ content: [{ type: 'text' as const, text: productText(options.prompt) }], finishReason: 'stop' as const, usage: { inputTokens: 12, outputTokens: 20, totalTokens: 32 }, warnings: [] }),
      // 保留产品 Agent 在 Studio 中的原生 stream 能力。
      doStream: async (options) => ({ stream: new ReadableStream({
        // 仅发送固定文本协议；不把测试样例写成真实推理证据。
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 'fixture-product' });
          controller.enqueue({ type: 'text-delta', id: 'fixture-product', delta: productText(options.prompt) });
          controller.enqueue({ type: 'text-end', id: 'fixture-product' });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 20, totalTokens: 32 } });
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
