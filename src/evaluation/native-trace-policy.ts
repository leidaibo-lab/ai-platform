/** 兼容已有隔离试点入口；实际策略由主线共享。 */
export { minimizeLocalSpan as minimizePilotSpan, LocalTraceExporter as PilotMinimalTraceExporter } from '../mastra/local-observability.js';
