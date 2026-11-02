import { join } from "node:path";
import { createFixture } from "./fixture.mjs";
import { createRunEventSink } from "../../src/runtime/run-event-sink.mjs";

/** 在一次性子进程中制造 ToolResult 后崩溃，或等待租约过期后恢复原 Run。 */
async function main() {
  const [engine, directory, phase] = process.argv.slice(2);
  const fixture = createFixture({ engine, databasePath: join(directory, "poc.sqlite"), evidencePath: join(directory, "connector.txt") });
  try {
    if (phase === "crash") {
      const conversation = fixture.runtime.createConversation();
      /** 只在持久化完成后的易失事件点退出，模拟真实进程丢失。 */
      function crashAfterCommit(event) { if (event.type === "tool.completed") process.exit(73); }
      await fixture.runtime.runConversation(conversation.id, { operation: "conversation.chat",
        requestId: "poc-request", clientMessageId: "poc-message", message: "今天深圳天气",
        imageUrls: [], documentUrls: [], references: [] }, { eventSink: createRunEventSink({ subscribers: [crashAfterCommit] }) });
      throw new Error("checkpoint not reached");
    }
    // 租约 TTL 固定一秒；只在独立故障 Worker 等待实际过期。
    await new Promise(
      /** 给旧 owner 的有效租约保留完整时间窗。 */
      (resolve) => setTimeout(resolve, 1100));
    await fixture.runtime.recoverInterruptedRuns();
    const conversation = fixture.runtime.listConversations()[0];
    const detail = fixture.runtime.getConversation(conversation.id);
    console.log(JSON.stringify({ status: detail.latestRun.status, acceptance: detail.latestRun.acceptance?.status,
      messageCount: detail.messages.length, connectorCalls: fixture.getConnectorCalls() }));
  } finally { fixture.close(); }
}
/** 输出失败诊断，仅包含假 fixture 数据。 */
function reportFailure(error) { console.error(error); process.exitCode = 1; }
main().catch(reportFailure);
