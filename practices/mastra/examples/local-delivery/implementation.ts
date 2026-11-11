/** 固定实现是流程测试输入；通过原生工具写入，不证明模型推理质量。 */
const validator = `/** 校验工单标题；Unicode按码点计数，输入保持不变。 */
export function validateTitle(value) {
  if (typeof value !== 'string') return { ok: false, error: 'TYPE' };
  const title = value.trim();
  const length = [...title].length;
  return length >= 1 && length <= 80 ? { ok: true, title } : { ok: false, error: 'LENGTH' };
}
`;
export const implementation: Readonly<Record<string, string>> = Object.freeze({
  'src/title.mjs': validator,
  'page.html': `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>工单标题校验</title>
<style>body{font:18px system-ui;max-width:680px;margin:80px auto;padding:24px;color:#183047}input{width:100%;box-sizing:border-box;padding:12px;margin:12px 0}button{padding:10px 22px}#result{overflow-wrap:anywhere}</style></head>
<body><h1>工单标题校验 v1</h1><label for="title">工单标题（1–80个字符）</label><input id="title"><button id="submit" type="button">校验标题</button><p id="result" role="status">请输入标题</p>
<script type="module">
${validator}
document.querySelector('#submit').addEventListener('click', /** 只显示校验文本，避免HTML注入。 */ () => {
  const result = validateTitle(document.querySelector('#title').value);
  document.querySelector('#result').textContent = result.ok ? result.title : '标题须为1–80个字符';
});
</script></body></html>`,
});
