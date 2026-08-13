import { randomUUID } from "node:crypto";

const DEFAULT_LEASE_TTL_MS = 30000;
const DEFAULT_RENEW_INTERVAL_MS = 10000;

/** Runtime 无法取得或保持 RunLease 时使用的稳定错误。 */
export class RunLeaseError extends Error {
  /**
   * @param {string} code - 稳定租约原因码。
   * @param {string} message - 服务端可读说明。
   */
  constructor(code, message) {
    super(message);
    this.name = "RunLeaseError";
    this.code = code;
  }
}

/**
 * 创建 Runtime 侧 RunLease 协调器；SQLite 事实与 fencing 判定仍由 Store 拥有。
 *
 * @param {object} input - Store 和租约参数。
 * @param {object} input.store - 提供 acquire/renew/release RunLease 的 Store Port。
 * @param {string} [input.ownerId] - 当前 Runtime 实例稳定 owner ID。
 * @param {number} [input.ttlMs] - 单次租约有效期。
 * @param {number} [input.renewIntervalMs] - 心跳间隔，必须小于有效期。
 * @returns {object} RunLease 协调器。
 */
export function createRunLeaseCoordinator({
  store,
  ownerId = `runtime-${process.pid}-${randomUUID()}`,
  ttlMs = DEFAULT_LEASE_TTL_MS,
  renewIntervalMs = DEFAULT_RENEW_INTERVAL_MS,
}) {
  requireLeaseStore(store);
  const normalizedOwnerId = requireIdentifier(ownerId, "ownerId");
  const normalizedTtlMs = normalizePositiveInteger(ttlMs, DEFAULT_LEASE_TTL_MS);
  const normalizedRenewIntervalMs = normalizePositiveInteger(
    renewIntervalMs,
    Math.min(DEFAULT_RENEW_INTERVAL_MS, Math.max(1, Math.floor(normalizedTtlMs / 3))),
  );
  if (normalizedRenewIntervalMs >= normalizedTtlMs) {
    throw new TypeError("renewIntervalMs must be less than ttlMs");
  }

  return Object.freeze({
    ownerId: normalizedOwnerId,

    /** 尝试取得指定 Run；竞争失败返回稳定结果，成功则启动可停止的心跳句柄。 */
    acquire({ runId, conversationId, abortController } = {}) {
      if (abortController !== undefined && !(abortController instanceof AbortController)) {
        throw new TypeError("abortController must be an AbortController");
      }
      const acquired = store.acquireRunLease({
        runId: requireIdentifier(runId, "runId"),
        conversationId: requireIdentifier(conversationId, "conversationId"),
        ownerId: normalizedOwnerId,
        ttlMs: normalizedTtlMs,
      });
      if (!acquired.acquired) {
        return Object.freeze({
          acquired: false,
          reasonCode: acquired.reasonCode || "lease_held",
          lease: acquired.lease || null,
        });
      }
      return Object.freeze({
        acquired: true,
        handle: createLeaseHandle({
          store,
          lease: acquired.lease,
          ttlMs: normalizedTtlMs,
          renewIntervalMs: normalizedRenewIntervalMs,
          abortController,
        }),
      });
    },
  });
}

/** 为已取得租约创建心跳、凭证、失效检测和幂等释放句柄。 */
function createLeaseHandle({ store, lease, ttlMs, renewIntervalMs, abortController }) {
  let currentLease = lease;
  let lostError = null;
  let stopped = false;
  let released = false;

  /** 定时续租；一旦失败就停止心跳并中断仍在运行的下游调用。 */
  function renewLeaseOnHeartbeat() {
    if (stopped || released || lostError) return;
    try {
      currentLease = store.renewRunLease({
        runId: currentLease.runId,
        ownerId: currentLease.ownerId,
        fencingToken: currentLease.fencingToken,
        ttlMs,
      });
    } catch (error) {
      lostError = toRunLeaseError(error);
      stopHeartbeat();
      if (abortController && !abortController.signal.aborted) abortController.abort(lostError);
    }
  }

  const timer = setInterval(renewLeaseOnHeartbeat, renewIntervalMs);
  timer.unref?.();

  /** 停止当前心跳，不修改 Store 中的租约事实。 */
  function stopHeartbeat() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }

  return Object.freeze({
    /** 返回当前 owner/token；token 在 renew 中保持不变。 */
    get credentials() {
      return Object.freeze({
        ownerId: currentLease.ownerId,
        fencingToken: currentLease.fencingToken,
      });
    },

    /** 返回心跳阶段记录的租约失效错误；未失效时为 null。 */
    get lostError() {
      return lostError;
    },

    /** 主动确认当前句柄尚未因续租失败失去所有权。 */
    assertOwned() {
      if (lostError) throw lostError;
      if (released) throw new RunLeaseError("lease_released", "Run lease has already been released");
    },

    /** 幂等释放当前 owner/token；旧 token 已失效时只返回失败证据，不覆盖原错误。 */
    release() {
      if (released) return Object.freeze({ released: true, lease: currentLease, replayed: true });
      stopHeartbeat();
      if (lostError) return Object.freeze({ released: false, reasonCode: lostError.code, lease: currentLease });
      try {
        const result = store.releaseRunLease({
          runId: currentLease.runId,
          ownerId: currentLease.ownerId,
          fencingToken: currentLease.fencingToken,
        });
        released = true;
        currentLease = result.lease;
        return Object.freeze({ ...result, replayed: false });
      } catch (error) {
        lostError = toRunLeaseError(error);
        return Object.freeze({ released: false, reasonCode: lostError.code, lease: currentLease });
      }
    },

    stop: stopHeartbeat,
  });
}

/** 将 Store 的稳定租约错误转换为 Runtime 协调错误。 */
function toRunLeaseError(error) {
  if (error instanceof RunLeaseError) return error;
  return new RunLeaseError(String(error?.code || "run_lease_lost"), "Runtime lost the Run lease");
}

/** 校验 Store 暴露完整 RunLease Port。 */
function requireLeaseStore(store) {
  if (
    typeof store?.acquireRunLease !== "function" ||
    typeof store?.renewRunLease !== "function" ||
    typeof store?.releaseRunLease !== "function"
  ) {
    throw new TypeError("store must provide the RunLease port");
  }
}

/** 校验租约标识不为空且不包含控制字符。 */
function requireIdentifier(value, fieldName) {
  const identifier = String(value || "").trim();
  if (!identifier || identifier.length > 240 || /[\r\n\0]/.test(identifier)) {
    throw new TypeError(`${fieldName} must be a stable identifier`);
  }
  return identifier;
}

/** 将 TTL 或间隔规范为正整数，无效值使用调用方默认值。 */
function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
