#!/usr/bin/env node
import assert from "node:assert/strict";

const baseUrl = String(process.env.LITELLM_GOVERNANCE_BASE_URL || "http://127.0.0.1:4100").replace(/\/$/, "");
const adminKey = requireValue("LITELLM_GOVERNANCE_MASTER_KEY");
const runtimeKey = requireValue("LITELLM_RUNTIME_KEY");
const teamId = String(process.env.LITELLM_RUNTIME_TEAM_ID || "ai-platform-local").trim();
const teamAlias = String(process.env.LITELLM_RUNTIME_TEAM_ALIAS || "AI Platform Local Runtime").trim();
const keyAlias = String(process.env.LITELLM_RUNTIME_KEY_ALIAS || "ai-platform-local-runtime").trim();
const model = String(process.env.LITELLM_MODEL || "governance-smoke").trim();
const maxBudget = readPositiveNumber("LITELLM_RUNTIME_MAX_BUDGET", 0.1);
const budgetDuration = String(process.env.LITELLM_RUNTIME_BUDGET_DURATION || "1d").trim();
const rpmLimit = readPositiveInteger("LITELLM_RUNTIME_RPM_LIMIT", 30);
const tpmLimit = readPositiveInteger("LITELLM_RUNTIME_TPM_LIMIT", 20_000);

/** 读取必填环境变量，不把值写入异常信息。 */
function requireValue(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** 将正数环境变量归一化，无效值回退到本地 PoC 默认值。 */
function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 将正整数环境变量归一化，无效值回退到本地 PoC 默认值。 */
function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** 将非 JSON 响应收口为空对象，HTTP 状态仍由调用方判断。 */
function returnEmptyObjectOnJsonParseError() {
  return {};
}

/** 使用管理凭据调用 LiteLLM team/key 管理 API。 */
async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${adminKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(returnEmptyObjectOnJsonParseError);
  return { response, data };
}

/** 读取资源；不存在时返回 null，其他失败保持为显式异常。 */
async function readOptional(path, label) {
  const result = await request(path);
  if (result.response.status === 404) return null;
  if (!result.response.ok) {
    throw new Error(`${label} lookup failed with status ${result.response.status}`);
  }
  return result.data;
}

/** 创建或更新固定 Runtime team，避免重复 provisioning 产生孤立资源。 */
async function provisionTeam() {
  const path = `/team/info?team_id=${encodeURIComponent(teamId)}`;
  const current = await readOptional(path, "team");
  const body = {
    team_id: teamId,
    team_alias: teamAlias,
    models: [model],
    max_budget: maxBudget,
    budget_duration: budgetDuration,
    rpm_limit: rpmLimit,
    tpm_limit: tpmLimit,
    metadata: { tenant_id: "local", app_id: "ai-platform-demo", purpose: "runtime" },
  };
  const result = await request(current ? "/team/update" : "/team/new", {
    method: "POST",
    body,
  });
  assert.equal(result.response.status, 200, `team provisioning returned ${result.response.status}`);
  return current ? "updated" : "created";
}

/** 创建或更新固定 Runtime virtual key，secret 始终只来自服务端环境变量。 */
async function provisionKey() {
  const path = `/key/info?key=${encodeURIComponent(runtimeKey)}`;
  const current = await readOptional(path, "key");
  const body = {
    key: runtimeKey,
    key_alias: keyAlias,
    team_id: teamId,
    models: [model],
    max_budget: maxBudget,
    budget_duration: budgetDuration,
    rpm_limit: rpmLimit,
    tpm_limit: tpmLimit,
    metadata: { tenant_id: "local", app_id: "ai-platform-demo", purpose: "runtime" },
  };
  const result = await request(current ? "/key/update" : "/key/generate", {
    method: "POST",
    body,
  });
  assert.equal(result.response.status, 200, `key provisioning returned ${result.response.status}`);
  return current ? "updated" : "created";
}

/** 执行幂等 provisioning，并仅输出非敏感资源摘要。 */
async function main() {
  const teamAction = await provisionTeam();
  const keyAction = await provisionKey();
  console.log(
    JSON.stringify({
      ok: true,
      teamId,
      teamAlias,
      keyAlias,
      models: [model],
      maxBudget,
      budgetDuration,
      rpmLimit,
      tpmLimit,
      teamAction,
      keyAction,
    }),
  );
}

await main();
