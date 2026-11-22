import { SpanType, type AnyExportedSpan, type InitExporterOptions, type ObservabilityExporter, type TracingEvent } from '@mastra/core/observability';
import { MastraStorageExporter, Observability } from '@mastra/observability';

const spanTypes = new Set<string>(Object.values(SpanType));
const spanId = /^[a-f0-9]{16}$/i;
const traceId = /^[a-f0-9]{32}$/i;
const runUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 只接受框架结构标识并构造允许字段；异常由导出器丢弃，绝不回退原文。 */
export function minimizeLocalSpan(span: AnyExportedSpan): AnyExportedSpan {
  if (!spanId.test(span.id) || !traceId.test(span.traceId) || !spanTypes.has(span.type) || (span.parentSpanId && !spanId.test(span.parentSpanId))) throw new Error('无效 Trace 结构');
  const runId = span.metadata?.runId;
  return {
    id: span.id, traceId: span.traceId, name: String(span.type), type: span.type,
    startTime: span.startTime, endTime: span.endTime, isEvent: span.isEvent, isRootSpan: span.isRootSpan,
    parentSpanId: span.parentSpanId,
    ...(span.errorInfo ? { errorInfo: { message: '[redacted]' } } : {}),
    ...(typeof runId === 'string' && runUuid.test(runId) ? { metadata: { runId } } : {}),
  } as AnyExportedSpan;
}

/** 将已过滤 Trace 委托给原生 Store；不订阅日志、指标、评分或反馈。 */
export class LocalTraceExporter implements ObservabilityExporter {
  readonly name = 'local-minimal-trace';
  private readonly storage = new MastraStorageExporter();
  /** 注入过滤函数供隔离测试验证失败关闭。 */
  constructor(private readonly minimize: (span: AnyExportedSpan) => AnyExportedSpan = minimizeLocalSpan) {}
  /** 将本机 Mastra Store 交给原生存储导出器初始化。 */
  init(options: InitExporterOptions) { return this.storage.init(options); }
  /** 过滤失败时丢弃事件，不记录原始数据。 */
  async exportTracingEvent(event: TracingEvent): Promise<void> {
    let sanitized: TracingEvent;
    try { sanitized = { type: event.type, exportedSpan: this.minimize(event.exportedSpan) }; }
    catch { return; }
    await this.storage.exportTracingEvent(sanitized);
  }
  /** 只接收 Trace，不暴露其他信号的处理方法。 */
  async onTracingEvent(event: TracingEvent): Promise<void> { await this.exportTracingEvent(event); }
  /** 等待已接收的 Trace 完成存储。 */
  async flush(): Promise<void> { await this.storage.flush(); }
  /** 关闭前刷新原生导出器。 */
  async shutdown(): Promise<void> { await this.storage.shutdown(); }
}

/** 显式装配本机 Trace；禁止默认远端导出和日志转发。 */
export function createLocalObservability() {
  return new Observability({ configs: { default: { serviceName: 'ai-platform-local', exporters: [new LocalTraceExporter()], logging: { enabled: false } } } });
}
