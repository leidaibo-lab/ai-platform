/** 服务端资料策略的唯一数值配置。随构建发布；不含权限、密钥或动态脚本。 */
export const materialPolicy = {
  version: 'material-policy.v1',
  budget: { maxLevel: 4, multiplier: 2, inlineBytes: 24000, materialBytes: 3000, readChars: 6000, readBytes: 48000, providerBytes: 96000 },
  chunks: { strategy: 'paragraph', chars: 3000, pageSize: 12, previewChars: 80, responseBytes: 12000 },
} as const;
