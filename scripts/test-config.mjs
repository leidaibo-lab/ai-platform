#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { resolveGatewayApiKey } from "../src/config/env.mjs";

/** 验证 Runtime virtual key 优先于仅供网关管理的 master key。 */
function testRuntimeKeyPrecedence() {
  assert.equal(
    resolveGatewayApiKey({
      LITELLM_RUNTIME_KEY: "sk-runtime",
      LITELLM_MASTER_KEY: "sk-admin",
    }),
    "sk-runtime",
  );
}

test("runtime virtual key takes precedence over LiteLLM master key", testRuntimeKeyPrecedence);

/** 验证旧本地环境在未发布 Runtime key 时保持兼容。 */
function testMasterKeyFallback() {
  assert.equal(resolveGatewayApiKey({ LITELLM_MASTER_KEY: "sk-admin" }), "sk-admin");
  assert.equal(resolveGatewayApiKey({}), "sk-local-admin-key");
}

test("legacy local configuration keeps the master key fallback", testMasterKeyFallback);
