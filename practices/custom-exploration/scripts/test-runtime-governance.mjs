#!/usr/bin/env node
import assert from "node:assert/strict";

const baseUrl = String(process.env.AI_PLATFORM_RUNTIME_BASE_URL || "http://127.0.0.1:4110").replace(/\/$/, "");
const expectedModel = String(process.env.LITELLM_MODEL || "governance-smoke").trim();

/** 将非 JSON 响应收口为空对象，保留实际 HTTP 状态供断言。 */
function returnEmptyObjectOnJsonParseError() {
  return {};
}

/** 调用 Runtime JSON API，并把失败限制为不含服务端凭据的公开响应。 */
async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(returnEmptyObjectOnJsonParseError);
  assert.equal(response.ok, true, `${path} returned ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

/** 验证客户端目录只反映 Runtime virtual key 的模型白名单。 */
async function assertRuntimeCatalog() {
  const status = await request("/api/gateway/status");
  assert.equal(status.ok, true);
  assert.equal(status.model, expectedModel);
  assert.deepEqual(status.models, [expectedModel]);
  assert.equal("apiKey" in status, false);
  assert.equal("teamId" in status, false);
  assert.equal("upstreamModel" in status, false);
  return { ok: status.ok, model: status.model, models: status.models };
}

/** 在显式开关下执行真实 Runtime Run，并从会话事实源核验最终状态。 */
async function runRealRuntimeSmoke() {
  const conversation = await request("/api/runtime/conversations", {
    method: "POST",
    body: { title: "Governance Runtime Smoke" },
  });
  const suffix = Date.now();
  await request(`/api/runtime/conversations/${conversation.id}/runs`, {
    method: "POST",
    body: {
      requestId: `governance-runtime-${suffix}`,
      clientMessageId: `governance-message-${suffix}`,
      message: "Reply with OK.",
      model: expectedModel,
    },
  });
  const detail = await request(`/api/runtime/conversations/${conversation.id}`);
  assert.equal(detail.latestRun?.status, "completed");
  assert.equal(detail.latestRun?.model, expectedModel);
  assert.ok(Number(detail.latestRun?.usage?.total_tokens) > 0);
  return {
    conversationId: conversation.id,
    runId: detail.latestRun.id,
    status: detail.latestRun.status,
    model: detail.latestRun.model,
    usage: detail.latestRun.usage,
  };
}

/** 执行默认无费用的目录检查，并按显式开关扩展真实 Run。 */
async function main() {
  const result = { ok: true, catalog: await assertRuntimeCatalog() };
  if (process.env.LITELLM_GOVERNANCE_ENABLE_REAL_RUNTIME_SMOKE === "true") {
    result.realRun = await runRealRuntimeSmoke();
  }
  console.log(JSON.stringify(result));
}

await main();
