/** 产研工作台的紧凑 Run 状态模块；只消费服务端已脱敏的流程投影。 */
import { useState } from 'react';

export interface RunFlowDocument {
  runId: string;
  status: string;
  outcome?: string;
  step?: string;
  gate?: { key: string; title: string };
  progress?: { phase: string; title: string };
  retry?: { step: string; title: string };
  intake?: { round?: number };
  developmentStop?: { reason: string };
  blockage?: unknown;
  product?: unknown;
}

interface FlowStage {
  id: string;
  label: string;
}

interface FlowStageState extends FlowStage {
  state: 'done' | 'active' | 'waiting' | 'failed' | 'pending';
}

const stages: readonly FlowStage[] = [
  { id: 'requirements', label: '需求' },
  { id: 'product', label: '产品' },
  { id: 'scope', label: '授权' },
  { id: 'development', label: '研发' },
  { id: 'testing', label: '测试' },
  { id: 'deployment', label: '发布' },
];

const developmentGates = new Set([
  'approve-architecture',
  'resolve-readiness',
  'resolve-findings',
  'recover-development',
]);

const testingGates = new Set(['approve-test-cases', 'review-test-results']);

const deploymentGates = new Set([
  'approve-release-scope',
  'execute-release-externally',
  'verify-release-health',
  'execute-rollback-externally',
]);

const stepTitles: Record<string, string> = {
  'guided-requirements': '需求澄清',
  'review-product': '产品稿审阅',
  'confirm-project-scope': '项目授权',
  'development-team': '研发实施',
  'resolve-development-blockers': '处理开工阻塞',
  'testing': '测试验证',
  'delivery': '发布交付',
};

/** 将当前 Run 映射到紧凑主流程的六个展示阶段。 */
export function getRunFlowStage(document?: RunFlowDocument): number {
  if (!document) return 0;
  const gate = document.gate?.key;
  if (gate === 'confirm-project-scope') return 2;
  if (gate && developmentGates.has(gate)) return 3;
  if (gate && testingGates.has(gate)) return 4;
  if (gate && deploymentGates.has(gate)) return 5;
  if (document.developmentStop || document.blockage) return 3;
  if (document.retry?.step.includes('testing')) return 4;
  if (document.retry?.step.includes('deployment') || document.retry?.step.includes('delivery')) return 5;
  if (document.retry?.step.includes('development') || document.retry?.step.includes('architecture')) return 3;
  if (document.progress?.phase && /测试|质量/.test(document.progress.phase)) return 4;
  if (document.progress?.phase && /发布|健康|回滚/.test(document.progress.phase)) return 5;
  if (document.progress?.phase && /开发|方案|架构|代码|开工/.test(document.progress.phase)) return 3;
  if (document.outcome === 'rejected') return 1;
  if (document.outcome === 'rolled-back' || document.outcome === 'delivery-confirmed' || document.outcome === 'fixture-completed') return 5;
  if (document.status === 'success') return 5;
  if (document.product) return 1;
  if (document.outcome === 'blocked') return 3;
  if (document.outcome) return 5;
  if (document.step === 'review-product') return 1;
  if (document.step === 'confirm-project-scope') return 2;
  if (document.step === 'guided-requirements') return 0;
  return 0;
}

/** 将服务端 Run 状态转换为用户可读的短标签。 */
function statusLabel(status: string): string {
  if (status === 'running') return '执行中';
  if (status === 'suspended' || status === 'waiting') return '等待处理';
  if (status === 'failed' || status === 'tripwire') return '执行失败';
  if (status === 'success') return '已结束';
  if (status === 'canceled' || status === 'bailed') return '已停止';
  return '待执行';
}

/** 为每个展示阶段计算状态；不根据客户端时间推断流程完成。 */
function buildStageStates(document: RunFlowDocument, currentStage: number): FlowStageState[] {
  const terminal = ['success', 'canceled', 'bailed'].includes(document.status);
  const failed = ['failed', 'tripwire'].includes(document.status);
  return stages.map((stage, index) => ({
    ...stage,
    state: index < currentStage
      ? 'done'
      : index > currentStage
        ? 'pending'
        : failed
          ? 'failed'
          : terminal && currentStage === stages.length - 1
            ? 'done'
            : document.status === 'suspended' || document.status === 'waiting'
              ? 'waiting'
              : 'active',
  }));
}

/** 选择当前节点的公开名称，优先展示人工关口、恢复点和后端阶段说明。 */
function currentNode(document: RunFlowDocument): string {
  if (document.gate?.title) return document.gate.title;
  if (document.retry?.title) return document.retry.title;
  if (document.progress?.phase) return document.progress.phase;
  if (document.step) return stepTitles[document.step] ?? stepTitles[document.step.split('.')[0]] ?? document.step;
  if (document.status === 'success') return '流程已完成';
  return '流程初始化';
}

/** 生成不暴露原始 payload 的当前节点补充说明。 */
function currentDetail(document: RunFlowDocument): string {
  if (document.gate) return '等待人工确认，提交后继续原 Run';
  if (document.retry) return '可从已保存检查点继续';
  if (document.progress) return document.progress.title;
  if (document.step === 'guided-requirements' && document.intake?.round) return `第 ${document.intake.round} 轮澄清，等待确认`;
  if (document.step === 'review-product') return '产品稿已生成，等待人工审阅';
  if (document.status === 'success') return '已保存最终流程结果';
  if (document.status === 'failed' || document.status === 'tripwire') return '已保存失败分类和恢复信息';
  return '后台正在读取最新快照';
}

/** 渲染嵌入工作台的小型 Run 流程模块；展开只显示公开摘要，不承担恢复操作。 */
export function RunFlowMini({ document }: { document: RunFlowDocument }) {
  const [expanded, setExpanded] = useState(false);
  const currentStage = Math.min(getRunFlowStage(document), stages.length - 1);
  const stageStates = buildStageStates(document, currentStage);
  const completed = stageStates.filter(stage => stage.state === 'done').length;
  const label = statusLabel(document.status);

  return <section className="run-flow-mini" aria-label="Run 执行状态">
    <div className="run-flow-mini-heading">
      <div><span className="intake-eyebrow">运行状态</span><strong>Run 执行流程</strong><small>{document.runId}</small></div>
      <span className={`run-flow-status run-flow-status-${stageStates[currentStage].state}`}>{label}</span>
    </div>
    <div className="run-flow-rail" role="list" aria-label="Run 主流程阶段">
      {stageStates.map((stage, index) => <div className={`run-flow-stage run-flow-stage-${stage.state}`} role="listitem" key={stage.id}>
        {index > 0 && <span className="run-flow-connector" aria-hidden="true" />}
        <span className="run-flow-dot" aria-hidden="true">{stage.state === 'done' ? '✓' : stage.state === 'failed' ? '!' : ''}</span>
        <span className="run-flow-stage-label">{stage.label}</span>
      </div>)}
    </div>
    <div className="run-flow-mini-summary">
      <div><span>当前节点</span><strong>{currentNode(document)}</strong><small>{currentDetail(document)}</small></div>
      <button type="button" aria-expanded={expanded} onClick={/** 只展开事实摘要，不触发恢复或提交。 */() => setExpanded(!expanded)}>{expanded ? '收起' : '详情'}</button>
    </div>
    {expanded && <div className="run-flow-mini-details" role="status">
      <span>阶段进度 <strong>{completed} / {stages.length}</strong></span>
      <span>Run 状态 <strong>{document.status}</strong></span>
      {document.gate && <span>人工关口 <strong>{document.gate.key}</strong></span>}
      {document.progress && <span>阶段说明 <strong>{document.progress.phase}</strong></span>}
    </div>}
  </section>;
}
