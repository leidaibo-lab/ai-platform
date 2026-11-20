import { architectureDocumentPath } from '../development/v2/architecture-document.js';
import { productPaths } from '../business-engineering/product-documents.js';
import { lifecycleSchema } from '../delivery/contracts.js';
import { z } from 'zod';
import { readHandoffFile } from '../delivery/remote-handoff.js';
import { deliverySchema, successorBaselineSchema } from '../mastra/workflows/delivery.js';

/** 主流程的最终交付汇总拥有最新开发、测试回执，早期终止则使用已审产品。 */
export function successorSource(result: unknown, product: unknown) {
  const lifecycle = lifecycleSchema.safeParse(result);
  if (lifecycle.success) {
    const { development, formalSpecifications } = lifecycle.data;
    const upstream = development.input.formalSpecifications?.find(item => item.kind === 'product');
    const testing = formalSpecifications?.filter(/** 只取当前正式测试规格回执。 */item => item.kind === 'testing').at(-1);
    return deliverySchema.parse({
      brief: lifecycle.data.brief, mode: development.mode, correlation: development.input.correlation,
      formalSpecifications: [upstream, development.formalSpecification, testing].filter(Boolean),
      artifacts: [], reviews: [], outcome: 'in-progress',
    });
  }
  return deliverySchema.safeParse(product).data ?? deliverySchema.safeParse(result).data;
}

export const successorArtifactKindsSchema = z.array(z.enum(['product', 'development', 'testing'])).min(1).max(3);

/** 只从来源 Run 保存的正式回执读取 Git 制品，禁止调用方传入 ref、路径或正文。 */
export function buildSuccessorBaseline(root: string, sourceRunId: string, source: unknown, kinds: unknown, changeBrief: unknown) {
  const delivery = deliverySchema.parse(source);
  const selected = [...new Set(successorArtifactKindsSchema.parse(kinds))];
  if (!delivery.formalSpecifications?.length) throw new Error('来源 Run 不包含已确认并推送的正式规格');
  const artifacts = selected.flatMap(kind => {
    const receipt = delivery.formalSpecifications!.find(/** 只取已登记的对应角色回执。 */item => item.kind === kind);
    if (!receipt) throw new Error(`来源 Run 不包含已确认的${kind}规格`);
    const scoped = delivery.correlation && productPaths(delivery.correlation.iterationId);
    const paths = kind === 'product'
      ? (scoped && receipt.paths.includes(scoped.specification) ? [scoped.requirements, scoped.specification] : ['specs/product-spec.md'])
      : kind === 'development' ? ['specs/development-spec.md', ...receipt.paths.filter(path => path === architectureDocumentPath)] : ['specs/test-spec.md'];
    return paths.map(/** 校验每份固定 Git 文件；产品基线同时包含业务规则与交付任务。 */path => {
      if (!receipt.paths.includes(path)) throw new Error(`来源 Run 不包含已确认的${kind}规格`);
      const content = readHandoffFile(root, receipt.handoff, path);
      const hash = receipt.handoff.files[path];
      if (!hash) throw new Error('来源规格回执不完整');
      return { kind, branch: receipt.handoff.branch, commit: receipt.handoff.commit, path, hash, content };
    });
  });
  return successorBaselineSchema.parse({ sourceRunId: z.string().uuid().parse(sourceRunId), changeBrief, artifacts, projectId: delivery.correlation?.projectId });
}
