import { WeatherConnectorError } from "../connectors/open-meteo-weather.mjs";

const WEATHER_TOPIC_PATTERN = /(天气|气温|温度|降水|降雨|下雨|湿度|风速)/u;
const UNSUPPORTED_WEATHER_TIME_PATTERN = /(昨天|前天|后天|大后天|上周|本周|下周|上个月|下个月|去年|历史|未来\s*(?:两|三|[2-9])\s*天)/u;
const WEATHER_ROUTE_NOISE_PATTERN = /(今天|今日|明天|明日|现在|当前|实时|天气|气温|温度|降水|降雨|下雨|湿度|风速|怎么样|如何|多少|几度|是否|会不会|有没有|查询|查一下|帮我|请|当地|这里|我这|的|是|吗|呢|呀|啊|[？?，,。\s])/gu;

/**
 * 创建 `get_weather` 平台工具定义；模型只看到地点和日期，不接触外部 URL。
 *
 * @param {object} weatherConnector - Open-Meteo Connector Port。
 * @returns {import("./tool-registry.mjs").ToolDefinition} 只读天气工具定义。
 */
export function createWeatherToolDefinition(weatherConnector) {
  if (typeof weatherConnector?.getWeather !== "function") {
    throw new TypeError("weatherConnector.getWeather is required");
  }
  return {
    name: "get_weather",
    title: "实时天气",
    description:
      "查询指定地点今天或明天的实时天气与预报。涉及当前温度、降雨、湿度、风速或天气时必须调用；不得凭模型记忆声称实时结果。",
    effect: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["location"],
      properties: {
        location: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          description: "明确的城市或地区名称，例如深圳、广东深圳。",
        },
        date: {
          type: "string",
          enum: ["today", "tomorrow"],
          default: "today",
          description: "查询今天使用 today，查询明天使用 tomorrow。",
        },
      },
    },
    /** 只在当前能力覆盖的时间范围且用户明确给出地点时强制首步天气调用。 */
    matchesInput({ message } = {}) {
      return matchesCurrentWeatherInput(message);
    },
    /** 把通过 schema 校验的输入交给固定天气 Connector。 */
    async execute(input, context = {}) {
      return weatherConnector.getWeather(input, { abortSignal: context.abortSignal });
    },
    /** 将 Connector 异常收敛为可持久化和回填模型的公开错误。 */
    toPublicError(error) {
      if (error instanceof WeatherConnectorError) {
        return {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        };
      }
      return {
        code: "weather_query_failed",
        message: "天气查询未能完成，请稍后重试。",
        retryable: false,
      };
    },
  };
}

/** 保守识别包含明确地点的今日或明日天气请求，缺地点时保留模型澄清空间。 */
function matchesCurrentWeatherInput(value) {
  const message = String(value || "").trim();
  if (!WEATHER_TOPIC_PATTERN.test(message) || UNSUPPORTED_WEATHER_TIME_PATTERN.test(message)) return false;
  return message.replace(WEATHER_ROUTE_NOISE_PATTERN, "").length >= 2;
}
