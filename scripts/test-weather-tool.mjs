#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { createOpenMeteoWeatherConnector, WeatherConnectorError } from "../src/connectors/open-meteo-weather.mjs";
import { createToolRegistry } from "../src/tools/tool-registry.mjs";
import { createWeatherToolDefinition } from "../src/tools/weather-tool.mjs";

// 验证 Connector 使用固定端点并把真实响应形状映射为稳定 weather.v1 结果。
test("Open-Meteo connector maps location, current weather, forecast, and source metadata", async () => {
  const urls = [];
  /** 按调用顺序返回地点和天气响应，并保留实际 URL 供安全断言。 */
  async function fakeFetch(url) {
    urls.push(new URL(url));
    if (urls.length === 1) {
      return jsonResponse({
        results: [
          {
            name: "深圳",
            latitude: 22.54554,
            longitude: 114.0683,
            country_code: "CN",
            country: "中国",
            admin1: "广东",
            timezone: "Asia/Shanghai",
            population: 17494398,
          },
        ],
      });
    }
    return jsonResponse({
      timezone: "Asia/Shanghai",
      current: {
        time: "2026-07-30T20:15",
        temperature_2m: 25.6,
        apparent_temperature: 31.1,
        relative_humidity_2m: 96,
        precipitation: 0,
        weather_code: 3,
        wind_speed_10m: 8.4,
      },
      daily: {
        time: ["2026-07-30", "2026-07-31"],
        weather_code: [95, 96],
        temperature_2m_max: [27.8, 29.3],
        temperature_2m_min: [24.6, 23.6],
        precipitation_sum: [10.5, 18],
        precipitation_probability_max: [79, 88],
        wind_speed_10m_max: [12.1, 14.1],
      },
    });
  }
  const connector = createOpenMeteoWeatherConnector({
    fetchImplementation: fakeFetch,
    nowImplementation: () => Date.parse("2026-07-30T12:16:00.000Z"),
  });

  const result = await connector.getWeather({ location: "深圳", date: "today" });

  assert.equal(urls[0].origin, "https://geocoding-api.open-meteo.com");
  assert.equal(urls[1].origin, "https://api.open-meteo.com");
  assert.equal(urls[0].searchParams.get("name"), "深圳");
  assert.equal(urls[1].searchParams.get("forecast_days"), "2");
  assert.equal(result.schemaVersion, "weather.v1");
  assert.equal(result.location.name, "深圳");
  assert.equal(result.forecast.condition.label, "雷雨");
  assert.equal(result.forecast.temperature.current, 25.6);
  assert.equal(result.observedAt, "2026-07-30T20:15");
  assert.equal(result.source.name, "Open-Meteo");
});

// 验证明日查询不把当前观测误标成明日数据。
test("Open-Meteo connector selects tomorrow without reusing current observations", async () => {
  const connector = createOpenMeteoWeatherConnector({ fetchImplementation: createSuccessfulFetch() });
  const result = await connector.getWeather({ location: "深圳", date: "tomorrow" });
  assert.equal(result.forecast.date, "2026-07-31");
  assert.equal(result.forecast.temperature.current, null);
  assert.equal(result.observedAt, null);
});

// 验证地点缺失使用稳定 404 分类，不把外部原始载荷透传给调用方。
test("Open-Meteo connector maps missing locations to a safe stable error", async () => {
  /** 返回空地点候选。 */
  async function fakeFetch() {
    return jsonResponse({ results: [] });
  }
  const connector = createOpenMeteoWeatherConnector({ fetchImplementation: fakeFetch });
  await assert.rejects(
    connector.getWeather({ location: "不存在地点", date: "today" }),
    /** 验证公开错误字段。 */
    function isLocationError(error) {
      return error instanceof WeatherConnectorError && error.code === "weather_location_not_found" && error.status === 404;
    },
  );
});

// 验证模型补充省级前缀时 Connector 只做受控地点简化，不扩大为任意搜索。
test("Open-Meteo connector retries a simplified Chinese administrative location", async () => {
  const urls = [];
  /** 先返回组合地名空结果，再为带城市后缀的候选和 Forecast 返回确定性响应。 */
  async function fakeFetch(url) {
    urls.push(new URL(url));
    if (urls.length === 1) return jsonResponse({ results: [] });
    if (urls.length === 2) {
      return jsonResponse({
        results: [
          {
            name: "珠海市",
            latitude: 35.87124,
            longitude: 119.99638,
            country_code: "CN",
            country: "中国",
            admin1: "山东",
            timezone: "Asia/Shanghai",
            population: 9999999,
          },
          {
            name: "珠海市",
            latitude: 22.27694,
            longitude: 113.56778,
            country_code: "CN",
            country: "中国",
            admin1: "广东",
            timezone: "Asia/Shanghai",
          },
        ],
      });
    }
    return jsonResponse({
      timezone: "Asia/Shanghai",
      current: {
        time: "2026-07-31T09:15",
        temperature_2m: 27,
        apparent_temperature: 32,
        relative_humidity_2m: 88,
        precipitation: 0,
        weather_code: 3,
        wind_speed_10m: 6,
      },
      daily: {
        time: ["2026-07-31", "2026-08-01"],
        weather_code: [95, 95],
        temperature_2m_max: [30, 29],
        temperature_2m_min: [25, 24],
        precipitation_sum: [10, 20],
        precipitation_probability_max: [80, 90],
        wind_speed_10m_max: [12, 14],
      },
    });
  }
  const connector = createOpenMeteoWeatherConnector({ fetchImplementation: fakeFetch });

  const result = await connector.getWeather({ location: "广东珠海", date: "today" });

  assert.deepEqual(urls.slice(0, 2).map(readLocationQuery), ["广东珠海", "珠海市"]);
  assert.equal(result.query.location, "广东珠海");
  assert.equal(result.location.name, "珠海市");
  assert.equal(result.location.admin1, "广东");
});

// 验证无省份的城市名不会被 Open-Meteo 返回的低置信度同名聚落抢占。
test("Open-Meteo connector prefers an administrative city over a same-name settlement", async () => {
  const urls = [];
  /** 复现公开接口对“珠海”和“珠海市”的不同候选结果。 */
  async function fakeFetch(url) {
    urls.push(new URL(url));
    if (urls.length === 1) {
      return jsonResponse({
        results: [
          {
            name: "珠海",
            latitude: 35.87124,
            longitude: 119.99638,
            feature_code: "PPL",
            country_code: "CN",
            country: "中国",
            admin1: "山东",
            timezone: "Asia/Shanghai",
          },
        ],
      });
    }
    if (urls.length === 2) {
      return jsonResponse({
        results: [
          {
            name: "珠海市",
            latitude: 22.27694,
            longitude: 113.56778,
            feature_code: "PPLA2",
            country_code: "CN",
            country: "中国",
            admin1: "广东",
            timezone: "Asia/Shanghai",
            population: 2207090,
          },
        ],
      });
    }
    return jsonResponse({
      timezone: "Asia/Shanghai",
      current: {
        time: "2026-07-31T09:15",
        temperature_2m: 30,
        apparent_temperature: 35,
        relative_humidity_2m: 80,
        precipitation: 0,
        weather_code: 3,
        wind_speed_10m: 6,
      },
      daily: {
        time: ["2026-07-31", "2026-08-01"],
        weather_code: [95, 95],
        temperature_2m_max: [32, 31],
        temperature_2m_min: [27, 26],
        precipitation_sum: [8, 12],
        precipitation_probability_max: [70, 80],
        wind_speed_10m_max: [12, 14],
      },
    });
  }
  const connector = createOpenMeteoWeatherConnector({ fetchImplementation: fakeFetch });

  const result = await connector.getWeather({ location: "珠海", date: "today" });

  assert.deepEqual(urls.slice(0, 2).map(readLocationQuery), ["珠海", "珠海市"]);
  assert.equal(result.location.name, "珠海市");
  assert.equal(result.location.admin1, "广东");
});

// 验证 Tool Registry 只暴露 allowlist 元数据，并通过 Runtime 包装器执行工具。
test("Tool Registry adapts the weather definition to an AI SDK tool", async () => {
  const connector = createOpenMeteoWeatherConnector({ fetchImplementation: createSuccessfulFetch() });
  const registry = createToolRegistry([createWeatherToolDefinition(connector)]);
  const executions = [];
  /** 模拟 Runtime 的持久化和审计包装器。 */
  async function executeTool(definition, input, options) {
    executions.push({ name: definition.name, input, toolCallId: options.toolCallId });
    return { status: "success", data: await definition.execute(input, { abortSignal: options.abortSignal }) };
  }
  const tools = registry.buildAiSdkTools();
  const toolsContext = registry.buildAiSdkToolsContext(executeTool);
  const invalidInput = await tools.get_weather.inputSchema["~standard"].validate({ location: "" });
  const defaultedInput = await tools.get_weather.inputSchema["~standard"].validate({ location: "深圳" });
  const validContext = await tools.get_weather.contextSchema["~standard"].validate(toolsContext.get_weather);
  const missingContext = await tools.get_weather.contextSchema["~standard"].validate({});
  const pollutedContext = await tools.get_weather.contextSchema["~standard"].validate({
    ...toolsContext.get_weather,
    tenantSecret: "must-not-pass",
  });
  const result = await tools.get_weather.execute(
    { location: "深圳", date: "today" },
    { toolCallId: "call-1", messages: [], context: toolsContext.get_weather },
  );
  assert.ok(invalidInput.issues?.length > 0);
  assert.deepEqual(defaultedInput.value, { location: "深圳", date: "today" });
  assert.equal(validContext.issues, undefined);
  assert.equal(validContext.value.executeTool, executeTool);
  assert.ok(missingContext.issues?.length > 0);
  assert.ok(pollutedContext.issues?.length > 0);
  assert.equal(registry.hasTools(), true);
  assert.deepEqual(registry.list().map(readToolName), ["get_weather"]);
  assert.equal(registry.resolveRequiredTool({ message: "今天深圳天气怎么样" }), "get_weather");
  assert.equal(registry.resolveRequiredTool({ message: "今天天气怎么样" }), null);
  assert.equal(registry.resolveRequiredTool({ message: "下周深圳天气怎么样" }), null);
  assert.deepEqual(executions, [{ name: "get_weather", input: { location: "深圳", date: "today" }, toolCallId: "call-1" }]);
  assert.equal(result.data.source.name, "Open-Meteo");
});

/** 创建覆盖地点和两日天气的确定性 Fetch Port。 */
function createSuccessfulFetch() {
  let call = 0;
  /** 返回确定性 Open-Meteo 响应。 */
  return async function successfulFetch() {
    call += 1;
    if (call === 1) {
      return jsonResponse({
        results: [
          {
            name: "深圳",
            latitude: 22.54554,
            longitude: 114.0683,
            country_code: "CN",
            country: "中国",
            admin1: "广东",
            timezone: "Asia/Shanghai",
            population: 17494398,
          },
        ],
      });
    }
    return jsonResponse({
      timezone: "Asia/Shanghai",
      current: {
        time: "2026-07-30T20:15",
        temperature_2m: 25.6,
        apparent_temperature: 31.1,
        relative_humidity_2m: 96,
        precipitation: 0,
        weather_code: 3,
        wind_speed_10m: 8.4,
      },
      daily: {
        time: ["2026-07-30", "2026-07-31"],
        weather_code: [95, 96],
        temperature_2m_max: [27.8, 29.3],
        temperature_2m_min: [24.6, 23.6],
        precipitation_sum: [10.5, 18],
        precipitation_probability_max: [79, 88],
        wind_speed_10m_max: [12.1, 14.1],
      },
    });
  };
}

/** 创建 JSON Fetch Response。 */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 返回公开工具名。 */
function readToolName(value) {
  return value.name;
}

/** 返回 Geocoding URL 中的地点查询参数。 */
function readLocationQuery(url) {
  return url.searchParams.get("name");
}
