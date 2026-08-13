#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { createResultAcceptanceRegistry } from "../src/runtime/result-acceptance.mjs";

// 验证完整天气证据由系统独立接受，而不是依赖模型声明完成。
test("weather acceptance binds location, time, source, and a result fact", () => {
  const registry = createResultAcceptanceRegistry();
  const result = registry.evaluate({
    candidateContent: "深圳当前 29°C，数据时间 2026-08-13 10:00，来源 Open-Meteo。",
    toolCalls: [completedWeatherCall()],
  });

  assert.equal(result.status, "accepted");
  assert.deepEqual(result.reasonCodes, ["weather_evidence_bound"]);
  assert.equal(result.evidence.checks.resultFactBound, true);
});

// 验证缺少任一关键证据时返回可定位的 rejected 原因码。
test("weather acceptance rejects a candidate without source and result fact", () => {
  const registry = createResultAcceptanceRegistry();
  const result = registry.evaluate({
    candidateContent: "深圳天气已更新，数据时间 2026-08-13 10:00。",
    toolCalls: [completedWeatherCall()],
  });

  assert.equal(result.status, "rejected");
  assert.deepEqual(result.reasonCodes, ["weather_source_missing", "weather_result_fact_missing"]);
});

// 验证缺失的可选天气字段不能经数值转换伪装成零值事实。
test("weather acceptance does not treat missing values as zero-valued evidence", () => {
  const registry = createResultAcceptanceRegistry();
  const toolCall = completedWeatherCall();
  toolCall.output.data.forecast = { date: "2026-08-13", temperature: {} };
  const result = registry.evaluate({
    candidateContent: "深圳在 2026-08-13 的降水概率为 0%，来源 Open-Meteo。",
    toolCalls: [toolCall],
  });

  assert.equal(result.status, "rejected");
  assert.deepEqual(result.reasonCodes, ["weather_result_fact_missing"]);
});

// 验证工具失败只能形成明确失败说明，不能夹带伪造的实测温度。
test("weather acceptance accepts disclosed failure and rejects fabricated measurements", () => {
  const registry = createResultAcceptanceRegistry();
  const failedToolCalls = [failedWeatherCall()];
  const disclosed = registry.evaluate({
    candidateContent: "天气查询未能完成，请稍后重试。",
    toolCalls: failedToolCalls,
  });
  const fabricated = registry.evaluate({
    candidateContent: "天气查询失败，但当前温度是 29°C。",
    toolCalls: failedToolCalls,
  });

  assert.equal(disclosed.status, "accepted");
  assert.deepEqual(disclosed.reasonCodes, ["weather_failure_disclosed"]);
  assert.equal(fabricated.status, "rejected");
  assert.deepEqual(fabricated.reasonCodes, ["weather_failure_not_disclosed"]);
});

// 验证普通未受管工具或无工具回答保持 acceptance=null，不伪装为系统已验收。
test("unmanaged results do not receive an acceptance claim", () => {
  const registry = createResultAcceptanceRegistry();
  assert.equal(registry.evaluate({ candidateContent: "普通回答", toolCalls: [] }), null);
});

/** 构造带完整 weather.v1 数据的 completed ToolCall。 */
function completedWeatherCall() {
  return {
    toolCallId: "weather-call-1",
    toolName: "get_weather",
    status: "completed",
    source: "Open-Meteo",
    observedAt: "2026-08-13T10:00",
    output: {
      status: "success",
      data: {
        schemaVersion: "weather.v1",
        query: { location: "深圳", date: "today" },
        location: { name: "深圳" },
        forecast: {
          date: "2026-08-13",
          condition: { label: "阴" },
          temperature: { current: 29 },
        },
        observedAt: "2026-08-13T10:00",
        source: { name: "Open-Meteo", retrievedAt: "2026-08-13T10:01:00.000Z" },
      },
    },
  };
}

/** 构造已经以公开错误收口的天气 ToolCall。 */
function failedWeatherCall() {
  return {
    toolCallId: "weather-call-failed",
    toolName: "get_weather",
    status: "failed",
    source: null,
    observedAt: null,
    output: null,
    error: {
      code: "weather_query_failed",
      message: "天气查询未能完成，请稍后重试。",
      retryable: false,
    },
  };
}
