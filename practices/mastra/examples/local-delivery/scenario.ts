/** 示例输入和验收资产只读；固定模型输出不代表真实模型开发能力。 */
import { readFileSync } from 'node:fs';
import type { DevelopmentInput } from '../../src/development/contracts.js';
import type { BrowserCase } from '../../src/browser-qa/contracts.js';

export const brief = '实现工单标题校验页：输入去首尾空格，按Unicode码点计数，1到80含边界为有效；非字符串为TYPE，空白或超长为LENGTH。页面包含#title输入、#submit按钮、#result反馈；成功显示去空白标题，失败显示标题须为1–80个字符。无需数据库或外部网络。页面标明工单标题校验 v1。交付src/title.mjs的validateTitle和page.html，仅修改这两个文件。独立测试后发布到本机回环服务；健康失败恢复上一版。';
export const previousPage = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>上一版本</title><h1>工单标题校验 v0</h1><p id="result">上一版本已恢复</p></html>';

/** 初始占位源码用于证明工具实际修改，检查文件不进入写入白名单。 */
export function exampleProject(): DevelopmentInput['project'] {
  return { id: 'local-title-delivery', files: { 'src/title.mjs': '/** 待实现的候选占位。 */\nexport const pending = true;\n', 'page.html': '<!doctype html><p>待实现</p>', 'acceptance.mjs': readFileSync(new URL('./acceptance.mjs', import.meta.url), 'utf8') }, writablePaths: ['src/title.mjs', 'page.html'], checkFiles: ['acceptance.mjs'], roles: ['frontend'] };
}

/** 批准的浏览器用例共享实际输入与可见预期；不能由Agent改断言。 */
export function browserCases(): { id: string; expected: string; browser: BrowserCase }[] {
  return [
    { id: 'trim', expected: '修复登录', browser: { entry: 'page.html', assets: [], actions: [{ action: 'fill', selector: '#title', value: '  修复登录  ' }, { action: 'click', selector: '#submit', value: '' }], assertions: [{ selector: '#result', text: '修复登录' }] } },
    { id: 'blank', expected: '标题须为1–80个字符', browser: { entry: 'page.html', assets: [], actions: [{ action: 'fill', selector: '#title', value: '   ' }, { action: 'click', selector: '#submit', value: '' }], assertions: [{ selector: '#result', text: '标题须为1–80个字符' }] } },
    { id: 'unicode', expected: '😀'.repeat(80), browser: { entry: 'page.html', assets: [], actions: [{ action: 'fill', selector: '#title', value: '😀'.repeat(80) }, { action: 'click', selector: '#submit', value: '' }], assertions: [{ selector: '#result', text: '😀'.repeat(80) }] } },
  ];
}
