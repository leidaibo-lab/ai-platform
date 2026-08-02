import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = String(process.env.LITELLM_GOVERNANCE_BASE_URL || "http://127.0.0.1:4100").replace(/\/$/, "");
const masterKey = process.env.LITELLM_GOVERNANCE_MASTER_KEY;
const smokeModel = "governance-smoke";

if (!masterKey) throw new Error("LITELLM_GOVERNANCE_MASTER_KEY is required");

/** 将非 JSON 响应收口为空值，避免解析错误掩盖实际 HTTP 状态。 */
function returnNullOnJsonParseError() {
  return null;
}

/** 向治理代理的管理 API 发送 JSON 请求，并在失败时保留安全诊断。 */
async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${masterKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await response.json().catch(returnNullOnJsonParseError);
  return { response, body };
}

/** 创建专用于预算闸门验证的团队。 */
async function createTeam() {
  const suffix = Date.now().toString(36);
  const result = await request("/team/new", {
    method: "POST",
    body: JSON.stringify({
      team_alias: `governance-poc-${suffix}`,
      max_budget: 0.01,
      budget_duration: "1d",
      rpm_limit: 60,
      tpm_limit: 10_000,
      models: [smokeModel],
    }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.ok(result.body?.team_id, "team/new must return team_id");
  return result.body;
}

/** 创建零预算 virtual key，确保请求在进入上游前被 LiteLLM 硬拒绝。 */
async function createBlockedKey(teamId) {
  const result = await request("/key/generate", {
    method: "POST",
    body: JSON.stringify({
      team_id: teamId,
      key_alias: `budget-blocked-${Date.now().toString(36)}`,
      models: [smokeModel],
      max_budget: 0,
      budget_duration: "1d",
      rpm_limit: 5,
      tpm_limit: 1_000,
    }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.ok(result.body?.key, "key/generate must return a virtual key");
  return result.body.key;
}

/** 用零预算 key 调用模型，验证预算闸门而非上游模型可用性。 */
async function assertBudgetRejected(virtualKey) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${virtualKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: smokeModel,
      messages: [{ role: "user", content: "budget gate probe" }],
    }),
  });
  const body = await response.json().catch(returnNullOnJsonParseError);
  assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(body));
  assert.match(JSON.stringify(body), /budget|spend|exceed/i);
}

/** 创建受严格预算约束的 key，用于显式开启的真实 spend smoke。 */
async function createSpendKey(teamId) {
  const result = await request("/key/generate", {
    method: "POST",
    body: JSON.stringify({
      team_id: teamId,
      key_alias: `spend-smoke-${Date.now().toString(36)}`,
      models: [smokeModel],
      max_budget: 0.05,
      budget_duration: "1d",
      rpm_limit: 1,
      tpm_limit: 1_000,
    }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.ok(result.body?.key, "key/generate must return a virtual key");
  return result.body.key;
}

/** 在显式开关下完成一次极小真实调用，供数据库 spend 记录验证使用。 */
async function runRealSpendSmoke() {
  const team = await createTeam();
  const virtualKey = await createSpendKey(team.team_id);
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${virtualKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: smokeModel,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_completion_tokens: 8,
    }),
  });
  const body = await response.json().catch(returnNullOnJsonParseError);
  assert.equal(response.status, 200, JSON.stringify(body));
  const spend = await waitForTeamSpend(team.team_id);
  return { teamId: team.team_id, usage: body?.usage || null, spend };
}

/** 轮询 team 管理 API，直到成功调用的累计费用已经异步更新。 */
async function waitForTeamSpend(teamId) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const result = await request(`/team/info?team_id=${encodeURIComponent(teamId)}`);
    assert.equal(result.response.status, 200, `team/info returned ${result.response.status}`);
    const team = result.body?.team_info;
    if (team?.team_id === teamId && Number(team.spend) > 0) {
      return {
        spend: team.spend,
        maxBudget: team.max_budget,
      };
    }
    await delay(1_000);
  }
  throw new Error(`No positive team spend found for team ${teamId}`);
}

/** 执行最小治理闭环，输出不包含 master key 或 virtual key。 */
async function main() {
  const team = await createTeam();
  const virtualKey = await createBlockedKey(team.team_id);
  await assertBudgetRejected(virtualKey);
  const result = { ok: true, teamId: team.team_id, budgetGate: "rejected" };
  if (process.env.LITELLM_GOVERNANCE_ENABLE_REAL_SPEND_SMOKE === "true") {
    result.realSpend = await runRealSpendSmoke();
  }
  console.log(JSON.stringify(result));
}

await main();
