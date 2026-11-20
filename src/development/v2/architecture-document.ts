import { z } from 'zod';

export const architectureDocumentFormat = 'architecture-markdown.v1';
export const architectureDocumentPath = 'specs/development-architecture.md';

const paragraph = z.string().trim().min(1).max(4000);
const nodeId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const diagramLabel = z.string().trim().regex(/^[\p{L}\p{N} _,，。·（）-]{1,72}$/u);
const diagramSchema = z.object({
  nodes: z.array(z.object({ id: nodeId, label: diagramLabel })).min(2).max(24),
  edges: z.array(z.object({ from: nodeId, to: nodeId, label: diagramLabel })).min(1).max(40),
});

export const architectureDocumentSchema = z.object({
  scope: paragraph,
  impact: paragraph,
  design: paragraph,
  architecture: diagramSchema,
  dataFlow: diagramSchema,
  implementation: paragraph,
  risks: paragraph,
});

type ArchitectureDocument = z.infer<typeof architectureDocumentSchema>;

/** 检查图中的节点身份、边端点和孤立节点。 */
export function validateArchitectureDocument(document: ArchitectureDocument): void {
  for (const text of [document.scope, document.impact, document.design, document.implementation, document.risks]) {
    if (/`{3,}|~{3,}/.test(text)) throw new SyntaxError('架构文档正文不可包含代码围栏');
  }
  for (const diagram of [document.architecture, document.dataFlow]) {
    const nodeIds = new Set(diagram.nodes.map(node => node.id));
    if (nodeIds.size !== diagram.nodes.length) throw new SyntaxError('架构文档图节点 ID 重复');
    const connected = new Set<string>();
    for (const { from, to } of diagram.edges) {
      if (!nodeIds.has(from) || !nodeIds.has(to)) throw new SyntaxError('架构文档图引用未知节点');
      connected.add(from);
      connected.add(to);
    }
    if (connected.size !== nodeIds.size) throw new SyntaxError('架构文档图存在孤立节点');
  }
}

/** 从受控节点和有向边生成 Mermaid 图源。 */
function mermaid(diagram: ArchitectureDocument['architecture']): string {
  const nodes = diagram.nodes.map(({ id, label }) => `  node_${id}["${label}"]`);
  const edges = diagram.edges.map(({ from, to, label }) => `  node_${from} -->|${label}| node_${to}`);
  return ['```mermaid', 'flowchart TD', ...nodes, ...edges, '```'].join('\n');
}

/** 从已保存的同一结构生成审批页和正式 Git 文件使用的 Markdown。 */
export function architectureMarkdown(document: ArchitectureDocument): string {
  return [
    '# 开发架构文档',
    '## 目标与边界', document.scope,
    '## 影响范围', document.impact,
    '## 设计与接口数据变更', document.design,
    '## 架构图', mermaid(document.architecture),
    '## 关键业务数据流', mermaid(document.dataFlow),
    '## 实施与验证', document.implementation,
    '## 风险与回滚', document.risks,
  ].join('\n\n') + '\n';
}
