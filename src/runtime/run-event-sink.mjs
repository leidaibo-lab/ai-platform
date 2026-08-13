/**
 * @typedef {object} RunEvent
 * @property {string} type - Runtime 生命周期事件类型，不复用渠道协议名称。
 * @property {string} conversationId - 事件所属会话。
 * @property {string} requestId - 当前幂等请求标识。
 * @property {string} chainTraceId - 当前业务链标识。
 * @property {string|null} runId - Run 创建前允许为空，创建后保持稳定。
 * @property {string} occurredAt - Runtime 发布事件的 ISO 8601 时间。
 */

/**
 * @typedef {object} RunEventDeliveryReport
 * @property {number} subscriberCount - 当前 Sink 的订阅者数量。
 * @property {number} deliveredCount - 成功处理该事件的订阅者数量。
 * @property {number} failedCount - 处理失败但已被隔离的订阅者数量。
 */

/**
 * @typedef {object} RunEventSink
 * @property {(event: RunEvent) => Promise<RunEventDeliveryReport>} publish - 按发布顺序通知订阅者，订阅失败不得向 Runtime 反向传播。
 */

const RUN_EVENT_TYPES = Object.freeze([
  "chain-trace.started",
  "run.started",
  "text.delta",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "artifact.created",
  "run.completed",
  "run.cancelled",
  "run.error",
]);
const RUN_EVENT_TYPE_SET = new Set(RUN_EVENT_TYPES);

const NULL_DELIVERY_REPORT = Object.freeze({
  subscriberCount: 0,
  deliveredCount: 0,
  failedCount: 0,
});

const NULL_RUN_EVENT_SINK = Object.freeze({
  /** 没有观察者时直接返回空报告，不改变 Runtime 行为。 */
  async publish() {
    return NULL_DELIVERY_REPORT;
  },
});

/**
 * 创建进程内 Runtime 事件端口。
 * Observer 模式把执行生命周期与 SSE、Trace 和故障注入等订阅者分离；事件只用于实时观察，
 * Conversation Store 中的事实事件仍是可恢复历史。
 *
 * @param {object} [options] - 订阅者和隔离错误观察器。
 * @param {Array<(event: RunEvent) => Promise<void>|void>} [options.subscribers] - 按顺序接收同一不可变事件快照的订阅者。
 * @param {(error: unknown, context: {event: RunEvent, subscriberIndex: number}) => Promise<void>|void} [options.onSubscriberError] - 接收脱离主执行链的订阅失败。
 * @returns {RunEventSink} 不向发布方抛出订阅错误的事件端口。
 */
export function createRunEventSink({ subscribers = [], onSubscriberError = ignoreSubscriberError } = {}) {
  const normalizedSubscribers = normalizeSubscribers(subscribers);
  if (typeof onSubscriberError !== "function") {
    throw new TypeError("run event onSubscriberError must be a function");
  }

  return Object.freeze({
    /** 创建一次不可变快照并按注册顺序通知全部订阅者。 */
    async publish(event) {
      const snapshot = createEventSnapshot(event);
      let deliveredCount = 0;
      let failedCount = 0;
      for (let index = 0; index < normalizedSubscribers.length; index += 1) {
        try {
          await normalizedSubscribers[index](snapshot);
          deliveredCount += 1;
        } catch (error) {
          failedCount += 1;
          await reportSubscriberError(onSubscriberError, error, snapshot, index);
        }
      }
      return Object.freeze({
        subscriberCount: normalizedSubscribers.length,
        deliveredCount,
        failedCount,
      });
    },
  });
}

/** 返回无订阅者的 Null Object，调用方无需为可选事件端口增加条件分支。 */
export function createNullRunEventSink() {
  return NULL_RUN_EVENT_SINK;
}

/** 校验订阅者集合并返回不会被调用方后续修改的数组。 */
function normalizeSubscribers(subscribers) {
  if (!Array.isArray(subscribers)) throw new TypeError("run event subscribers must be an array");
  for (const subscriber of subscribers) {
    if (typeof subscriber !== "function") throw new TypeError("run event subscriber must be a function");
  }
  return Object.freeze([...subscribers]);
}

/** 为单次发布补齐时间并创建与 Runtime 原对象隔离的深冻结快照。 */
function createEventSnapshot(event) {
  if (!event || typeof event !== "object" || !RUN_EVENT_TYPE_SET.has(event.type)) {
    throw new TypeError("unsupported Runtime run event");
  }
  const snapshot = structuredClone({
    ...event,
    runId: event.runId == null ? null : String(event.runId),
    occurredAt: event.occurredAt || new Date().toISOString(),
  });
  return deepFreeze(snapshot);
}

/** 递归冻结事件中的普通对象和数组，防止前序订阅者污染后续观察结果。 */
function deepFreeze(value, visited = new WeakSet()) {
  if (!value || typeof value !== "object" || visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) deepFreeze(child, visited);
  return Object.freeze(value);
}

/** 报告订阅失败；错误观察器自身失败也必须留在旁路。 */
async function reportSubscriberError(onSubscriberError, error, event, subscriberIndex) {
  try {
    await onSubscriberError(error, { event, subscriberIndex });
  } catch {
    // 事件观察链不能成为 Runtime 执行链的新失败源。
  }
}

/** 默认忽略订阅错误，由需要观测 Delivery 的装配层显式注入观察器。 */
function ignoreSubscriberError() {}

export { RUN_EVENT_TYPES };
