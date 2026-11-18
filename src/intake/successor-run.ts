import { z } from 'zod';
import { readHandoffFile } from '../delivery/remote-handoff.js';
import { deliverySchema, successorBaselineSchema } from '../mastra/workflows/delivery.js';

export const successorArtifactKindsSchema = z.array(z.enum(['product', 'development', 'testing'])).min(1).max(3);

/** 只从来源 Run 保存的正式回执读取 Git 制品，禁止调用方传入 ref、路径或正文。 */
export function buildSuccessorBaseline(root: string, sourceRunId: string, source: unknown, kinds: unknown, changeBrief: unknown) {
  const delivery = deliverySchema.parse(source);
  const selected = [...new Set(successorArtifactKindsSchema.parse(kinds))];
  if (!delivery.formalSpecifications?.length) throw new Error('来源 Run 不包含已确认并推送的正式规格');
  const artifacts = selected.map(kind => {
    const receipt = delivery.formalSpecifications!.find(item => item.kind === kind);
    const path = kind === 'product' ? 'specs/product-spec.md' : kind === 'development' ? 'specs/development-spec.md' : 'specs/test-spec.md';
    if (!receipt || !receipt.paths.includes(path)) throw new Error(`来源 Run 不包含已确认的${kind}规格`);
    const content = readHandoffFile(root, receipt.handoff, path);
    const hash = receipt.handoff.files[path];
    if (!hash) throw new Error('来源规格回执不完整');
    return { kind, branch: receipt.handoff.branch, commit: receipt.handoff.commit, path, hash, content };
  });
  return successorBaselineSchema.parse({ sourceRunId: z.string().uuid().parse(sourceRunId), changeBrief, artifacts });
}
