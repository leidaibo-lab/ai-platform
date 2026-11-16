const DEFAULT_GEOCODING_BASE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const DEFAULT_FORECAST_BASE_URL = "https://api.open-meteo.com/v1/forecast";
const DEFAULT_TIMEOUT_MS = 8000;
const CHINA_ADMIN_PREFIXES = Object.freeze([
  "黑龙江",
  "内蒙古",
  "北京",
  "天津",
  "上海",
  "重庆",
  "河北",
  "山西",
  "辽宁",
  "吉林",
  "江苏",
  "浙江",
  "安徽",
  "福建",
  "江西",
  "山东",
  "河南",
  "湖北",
  "湖南",
  "广东",
  "广西",
  "海南",
  "四川",
  "贵州",
  "云南",
  "西藏",
  "陕西",
  "甘肃",
  "青海",
  "宁夏",
  "新疆",
  "台湾",
  "香港",
  "澳门",
]);

const WEATHER_CODE_LABELS = Object.freeze({
  0: "晴",
  1: "大部晴朗",
  2: "局部多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "强毛毛雨",
  56: "轻微冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "轻微冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "米雪",
  80: "小阵雨",
  81: "中阵雨",
  82: "强阵雨",
  85: "小阵雪",
  86: "大阵雪",
  95: "雷雨",
  96: "雷雨伴小冰雹",
  99: "雷雨伴大冰雹",
});

export class WeatherConnectorError extends Error {
  /** 保存可持久化和回填模型的安全错误分类。 */
  constructor(code, message, { status = 502, retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "WeatherConnectorError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * 创建固定访问 Open-Meteo Geocoding 和 Forecast API 的只读 Connector。
 * Adapter 模式把外部字段收敛为平台稳定的 weather.v1 ToolResult。
 *
 * @param {object} [options] - 超时、Fetch Port 和测试端点注入。
 * @returns {{getWeather: (input: object, context?: object) => Promise<object>}} 天气查询接口。
 */
export function createOpenMeteoWeatherConnector({
  fetchImplementation = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  geocodingBaseUrl = DEFAULT_GEOCODING_BASE_URL,
  forecastBaseUrl = DEFAULT_FORECAST_BASE_URL,
  nowImplementation = Date.now,
} = {}) {
  const requestTimeoutMs = normalizePositiveNumber(timeoutMs, DEFAULT_TIMEOUT_MS);

  return {
    /** 按地点查询今天或明天的结构化天气，外部 URL 不由调用方控制。 */
    async getWeather(input, { abortSignal } = {}) {
      const locationQuery = normalizeLocation(input?.location);
      const dateMode = normalizeDateMode(input?.date);
      const location = await resolveLocation({
        fetchImplementation,
        geocodingBaseUrl,
        locationQuery,
        abortSignal,
        timeoutMs: requestTimeoutMs,
      });
      if (!location) {
        throw new WeatherConnectorError("weather_location_not_found", "没有找到对应地点，请补充城市或地区。", {
          status: 404,
        });
      }

      const forecastUrl = buildForecastUrl(forecastBaseUrl, location);
      const forecast = await requestJson(fetchImplementation, forecastUrl, {
        abortSignal,
        timeoutMs: requestTimeoutMs,
        operation: "weather.forecast",
      });
      return mapWeatherResult({
        locationQuery,
        dateMode,
        location,
        forecast,
        retrievedAt: new Date(nowImplementation()).toISOString(),
      });
    },
  };
}

/** 按原始地点和受控中文行政区简化候选依次查询，返回首个有效坐标。 */
async function resolveLocation({ fetchImplementation, geocodingBaseUrl, locationQuery, abortSignal, timeoutMs }) {
  const adminConstraint = readChinaAdminConstraint(locationQuery);
  let fallback = null;
  for (const query of buildGeocodingQueries(locationQuery)) {
    const locationUrl = new URL(geocodingBaseUrl);
    locationUrl.searchParams.set("name", query);
    locationUrl.searchParams.set("count", "5");
    locationUrl.searchParams.set("language", "zh");
    locationUrl.searchParams.set("format", "json");
    const geocoding = await requestJson(fetchImplementation, locationUrl, {
      abortSignal,
      timeoutMs,
      operation: "weather.geocode",
    });
    const location = selectLocation(geocoding?.results, query, adminConstraint);
    if (!location) continue;
    if (isConfidentLocation(location, adminConstraint)) return location;
    fallback ||= location;
  }
  return fallback;
}

/** 生成有限地点候选，只移除中国省级前缀和城市末尾行政区后缀。 */
function buildGeocodingQueries(locationQuery) {
  const queries = [locationQuery];
  const withoutTrailingSuffix = locationQuery.replace(/[市区县州]$/u, "");
  if (withoutTrailingSuffix !== locationQuery) queries.push(withoutTrailingSuffix);
  let hasAdminPrefix = false;
  for (const prefix of CHINA_ADMIN_PREFIXES) {
    if (!locationQuery.startsWith(prefix) || locationQuery.length <= prefix.length) continue;
    hasAdminPrefix = true;
    const regionalName = locationQuery
      .slice(prefix.length)
      .replace(/^(?:省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)/u, "")
      .trim();
    if (!regionalName) break;
    if (!/[市区县州]$/u.test(regionalName)) queries.push(`${regionalName}市`);
    queries.push(regionalName, regionalName.replace(/[市区县州]$/u, ""));
    break;
  }
  if (!hasAdminPrefix && /^[\p{Script=Han}]+$/u.test(locationQuery) && !/[市区县州]$/u.test(locationQuery)) {
    queries.push(`${locationQuery}市`);
  }
  return [...new Set(queries)];
}

/** 从组合地名中提取省级约束，供简化查询继续过滤同名地点。 */
function readChinaAdminConstraint(locationQuery) {
  return CHINA_ADMIN_PREFIXES.find(
    /** 只把确实带后续地名的前缀视为行政区约束。 */
    function matchesAdminPrefix(prefix) {
      return locationQuery.startsWith(prefix) && locationQuery.length > prefix.length;
    },
  ) || null;
}

/** 创建只包含固定天气字段和两天窗口的 Forecast URL。 */
function buildForecastUrl(baseUrl, location) {
  const url = new URL(baseUrl);
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,rain,weather_code,wind_speed_10m",
  );
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max",
  );
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "2");
  return url;
}

/** 在独立超时和调用方取消信号下读取 JSON，并统一映射外部错误。 */
async function requestJson(fetchImplementation, url, { abortSignal, timeoutMs, operation }) {
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    /** 在 Connector 局部预算耗尽时中断当前 HTTP 请求。 */
    function abortTimedOutRequest() {
      timeoutController.abort(new DOMException("Weather request timed out", "TimeoutError"));
    },
    timeoutMs,
  );
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await fetchImplementation(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response?.ok) {
      const status = Number(response?.status) || 502;
      throw new WeatherConnectorError("weather_provider_unavailable", "天气服务暂时不可用。", {
        status,
        retryable: status === 429 || status >= 500,
      });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new WeatherConnectorError("weather_invalid_response", "天气服务返回了无法识别的数据。", {
        status: 502,
        retryable: true,
        cause: error,
      });
    }
  } catch (error) {
    if (abortSignal?.aborted) throw abortSignal.reason || new DOMException("Run was cancelled", "AbortError");
    if (timeoutController.signal.aborted) {
      throw new WeatherConnectorError("weather_timeout", "天气查询超时，请稍后重试。", {
        status: 504,
        retryable: true,
        cause: error,
      });
    }
    if (error instanceof WeatherConnectorError) throw error;
    throw new WeatherConnectorError("weather_provider_unavailable", "无法连接天气服务。", {
      status: 502,
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** 从同名候选中优先选择符合省级约束、中国大陆精确匹配和较高人口的地点。 */
function selectLocation(results, query, adminConstraint) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const normalizedQuery = query.toLowerCase();
  let selected = null;
  let selectedScore = -1;
  for (const candidate of results) {
    if (!Number.isFinite(candidate?.latitude) || !Number.isFinite(candidate?.longitude)) continue;
    if (adminConstraint && !String(candidate.admin1 || "").startsWith(adminConstraint)) continue;
    let score = Number(candidate.population || 0) / 1_000_000;
    if (String(candidate.name || "").toLowerCase() === normalizedQuery) score += 100;
    if (candidate.country_code === "CN") score += 20;
    if (score > selectedScore) {
      selected = candidate;
      selectedScore = score;
    }
  }
  return selected;
}

/** 判断地点候选是否达到城市级置信度，低置信度同名聚落会继续尝试有限候选。 */
function isConfidentLocation(location, adminConstraint) {
  if (adminConstraint) return true;
  if (String(location.feature_code || "").startsWith("PPLA")) return true;
  return Number(location.population || 0) >= 50_000;
}

/** 将 Open-Meteo 当前与日预报字段映射为带来源和数据时间的稳定结果。 */
function mapWeatherResult({ locationQuery, dateMode, location, forecast, retrievedAt }) {
  const targetIndex = dateMode === "tomorrow" ? 1 : 0;
  const daily = forecast?.daily || {};
  const targetDate = daily.time?.[targetIndex];
  if (!targetDate) {
    throw new WeatherConnectorError("weather_invalid_response", "天气服务没有返回目标日期的数据。", {
      status: 502,
      retryable: true,
    });
  }
  const weatherCode = Number(daily.weather_code?.[targetIndex]);
  const current = dateMode === "today" ? forecast?.current || null : null;
  return {
    schemaVersion: "weather.v1",
    query: { location: locationQuery, date: dateMode },
    location: {
      name: String(location.name || locationQuery),
      admin1: String(location.admin1 || ""),
      country: String(location.country || ""),
      countryCode: String(location.country_code || ""),
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      timezone: String(forecast?.timezone || location.timezone || ""),
    },
    forecast: {
      date: targetDate,
      condition: { code: weatherCode, label: weatherCodeLabel(weatherCode) },
      temperature: {
        current: current ? numberOrNull(current.temperature_2m) : null,
        apparent: current ? numberOrNull(current.apparent_temperature) : null,
        min: numberOrNull(daily.temperature_2m_min?.[targetIndex]),
        max: numberOrNull(daily.temperature_2m_max?.[targetIndex]),
        unit: "celsius",
      },
      precipitation: {
        current: current ? numberOrNull(current.precipitation) : null,
        sum: numberOrNull(daily.precipitation_sum?.[targetIndex]),
        probabilityMax: numberOrNull(daily.precipitation_probability_max?.[targetIndex]),
        unit: "mm",
      },
      humidity: current ? numberOrNull(current.relative_humidity_2m) : null,
      windSpeedMax: numberOrNull(daily.wind_speed_10m_max?.[targetIndex]),
      windSpeedCurrent: current ? numberOrNull(current.wind_speed_10m) : null,
      windSpeedUnit: "km/h",
    },
    observedAt: current?.time || null,
    source: {
      name: "Open-Meteo",
      url: "https://open-meteo.com/",
      retrievedAt,
    },
  };
}

/** 将 WMO 天气码映射为中文公开标签。 */
function weatherCodeLabel(code) {
  return WEATHER_CODE_LABELS[code] || "未知天气";
}

/** 校验并限制用户地点长度，避免空查询和无界工具参数。 */
function normalizeLocation(value) {
  const location = String(value || "").replace(/\s+/g, " ").trim();
  if (!location || location.length > 80 || /[\r\n\0]/.test(location)) {
    throw new WeatherConnectorError("weather_invalid_location", "地点必须是 1 到 80 个有效字符。", {
      status: 400,
    });
  }
  return location;
}

/** 将缺省日期归一化为今天，并拒绝当前工具范围外的日期。 */
function normalizeDateMode(value) {
  const mode = String(value || "today").trim().toLowerCase();
  if (mode !== "today" && mode !== "tomorrow") {
    throw new WeatherConnectorError("weather_invalid_date", "当前天气工具只支持今天或明天。", {
      status: 400,
    });
  }
  return mode;
}

/** 将外部数字字段限制为有限数值或 null。 */
function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 将可选超时转换为正数，异常配置回退到默认值。 */
function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
