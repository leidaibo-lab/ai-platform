/** 资料装配配置：只控制折叠与单次分页，不设置累计读取或模型字节门槛。 */
export const materialPolicy = {
  version: 'material-policy.v2',
  reading: { materialBytes: 3000, readChars: 6000 },
  chunks: { strategy: 'paragraph', chars: 3000, pageSize: 12, previewChars: 80, responseBytes: 12000 },
} as const;
