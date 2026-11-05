import type { ReviewDocument } from '../lib';
import { Markdown } from './Markdown';

const roleLabels = { coordinator: '总产品统筹', clarification: '需求梳理', closure: '产品闭环', writing: '产品写作' };

/** 展示各角色的已保存产物，便于产品经理定位遗漏来自哪个环节。 */
export function ProductWork({ document }: { document: ReviewDocument }) {
  if (!document.productWork?.entries.length) return null;
  return (
    <section className="review-history" aria-label="产品角色交付记录">
      <h3>产品角色交付记录</h3>
      <p>可展开检查各环节的分析依据和交付内容。</p>
      {/* 产物来自服务端快照，展开阅读不触发角色执行。 */}
      {document.productWork.entries.map((entry) => (
        <details className="original-brief" key={entry.role}>
          <summary>{roleLabels[entry.role]}</summary>
          <Markdown>{entry.content}</Markdown>
        </details>
      ))}
    </section>
  );
}
