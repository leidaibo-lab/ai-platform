import { formalRunBranch, publishFormalSpecification, readHandoffFile, type FormalSpecificationReceipt } from '../delivery/remote-handoff.js';
import { configuredProductPaths, productPaths, readProductDocuments } from './product-documents.js';

/** 提交同一批准版本的需求和产品任务，返回供下游读取的固定回执。 */
export async function publishProductHandoff(root: string, runId: string, iterationId: string, content: string, baseCommit?: string, templates?: { requirements: string; productSpecification: string }): Promise<FormalSpecificationReceipt> {
  const paths = templates ? configuredProductPaths(iterationId, templates) : productPaths(iterationId);
  const { requirements, specification } = readProductDocuments(content);
  const handoff = await publishFormalSpecification(root, runId, iterationId, {
    [paths.requirements]: requirements,
    [paths.specification]: specification,
  }, 'docs(spec): 提交已确认需求与产品规格', baseCommit, Object.values(paths));
  return { kind: 'product', handoff, paths: [paths.requirements, paths.specification], upstreamCommits: [] };
}

/** 核对两份 Git 正文是否与人工批准的完整版本一致。 */
export function verifyProductHandoff(root: string, runId: string, iterationId: string, receipt: FormalSpecificationReceipt, content: string, templates?: { requirements: string; productSpecification: string }) {
  const paths = templates ? configuredProductPaths(iterationId, templates) : productPaths(iterationId);
  if (receipt.kind !== 'product' || receipt.handoff.branch !== formalRunBranch(iterationId, runId) || receipt.paths.length !== 2 || !Object.values(paths).every(/** 两份文档均须在回执中登记。 */path => receipt.paths.includes(path))) {
    throw new Error('开发缺少本 Run 已发布的需求文档或产品规格');
  }
  const approved = readProductDocuments(content);
  for (const [key, path] of Object.entries(paths) as [keyof typeof paths, string][]) {
    if (readHandoffFile(root, receipt.handoff, path) !== approved[key]) throw new Error('已发布文件与当前人工批准版本不一致');
  }
}
