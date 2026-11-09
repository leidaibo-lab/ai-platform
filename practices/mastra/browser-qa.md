# Workflow 浏览器 QA

本实践保留 Mastra 原生 Workflow、Store、BMAD 方法和人工质量门，使用 gstack 的报告与浏览器检查方法，并由 Playwright 实际执行批准用例。选型、来源和维护边界见[ADR](../../docs/decisions/2026-11-09-mastra-gstack-browser-qa.md)。本文件是新增实践本地契约；不改变探索主线 Runtime/OpenSpec 稳定契约。

## 分工与执行

- Skill：`testing-gstack-browser-qa` 提供观察、假设、未测范围和证据报告方法。固定 gstack commit `b6155921a564ba9ec2470fd2cb3894c05e2c2d13`，原文、MIT 与 SHA256 位于根 Skill references；不执行上游安装、遥测或自动修复脚本。
- Agent：Workflow 内创建原生 QA Agent，注册该 Skill 与 `runBrowserCase` 工具。工具仅接受批准 caseId，模型不能改目标或断言；要求实际调用 skill、skill_read 和浏览器工具。
- 工具：Playwright 1.65.0 在独立 Chromium 上下文执行点击、输入、文本包含断言并截图。测试候选内存快照，不访问用户浏览器或宿主已有服务。
- Workflow：`execute-tests → execute-browser-qa → review-test-results`。Mastra Store 保存结果与恢复状态，人工确认仍是发布前必要条件。

## 安装与用例批准

在 `practices/mastra` 使用 Node 24+ 安装依赖，然后安装 Chromium：

```bash
npm ci
npx playwright install chromium --no-shell
```

已有浏览器缓存不随 npm lock 分发；浏览器缺失会明确返回 blocked。运行后端与工作台沿用 README。测试计划生成后，在用例批准关口选择 browser，并提供下例字段（requirementRefs 使用实际批准需求 ID）：

```json
{
  "id": "page-submit",
  "requirementRefs": ["R1"],
  "expected": "提交后显示姓名",
  "method": "browser",
  "checkRefs": [],
  "browser": {
    "entry": "page.html",
    "assets": [],
    "actions": [
      {"action": "fill", "selector": "#name", "value": "候选人"},
      {"action": "click", "selector": "#save", "value": ""}
    ],
    "assertions": [{"selector": "#result", "text": "候选人"}]
  }
}
```

入口与 assets 必须在项目初始声明的文件集合内，并从当前开发交付快照读取。只支持静态 html/css/js/svg/json，每文件最多100KB；不支持构建启动或动态 API。HRM 的全栈 executionProfile 尚无同版本启动 Adapter，登记浏览器用例后返回 blocked，不以宿主已有服务代替候选。

每轮最多3个用例，每用例最多30个附属资源、12次动作、12条断言。浏览器启动10秒，启动后页面上下文总预算20秒，定位1.5秒、导航5秒；Agent 总预算120秒、16步，每个批准 ID 最多执行一次。仅放行本次回环服务和显式资产的 GET/HEAD；限制外联、WebSocket、Service Worker、弹窗和下载。浏览器不继承模型密钥；该进程隔离不等于生产 Sandbox，仅用于本地可信候选与合成数据。

## 输入输出与质量门

`BrowserCase` 是批准且不可由模型扩张的输入。`browser-receipt.v1` 包含 caseId、caseHash、sourceHash、methodHash、开始时间、耗时、步骤观察、控制台错误、阻断请求数、状态和截图。状态为 passed/failed/blocked：断言不符或页面错误为 failed；浏览器缺失、动作未完成、超时、方法未加载或未执行为 blocked。只有工具实际结果决定状态，Agent 的自然语言报告不能替代证据。

每张 PNG 最大1MB，以 base64 和 SHA256 保存；模型只收到截图散列。`quality.browser` 保存回执、方法散列、报告、实际工具列表和整体摘要，`quality.results` 的 authority 为 browser-process。质量门验证批准用例集合、源码/方法/用例绑定、截图完整性与断言数量。人工结果只能补 manual 用例；浏览器失败或阻塞不能直接改为通过。

在工作台质量确认处查看截图、步骤与报告；同一质量对象随 Store 暂停恢复，并进入既有 quality.json 质量产物投影。旧 Run 无 browser 字段时保持原摘要，不补写新证据；旧计划缺方法绑定时不能新增 browser 用例，需重新生成计划。返工后重新批准、执行并保留旧质量历史。截图可能包含页面内容，只使用授权合成测试数据。

## 维护、退出与验证

方法维护者负责原文、许可、中文适配和来源锁升级；应用维护者负责契约、预算、浏览器版本及质量门。升级要检查上游差异、重算方法散列并重跑真实浏览器与 Workflow 恢复回归。停用后不再批准新 browser 用例，历史证据保留；不得把已批准的浏览器测试静默降级为人工通过。全栈启动、远程隔离或新权限需求触发 ADR 重评。

```bash
npm run check
npm test
npm run review:build
```

工程回归使用固定模型驱动真实 Mastra 工具循环和真实 Chromium。它证明执行、绑定与门禁，不证明真实模型的报告质量提升，也不代表 HRM 业务浏览器验收或生产隔离已完成。
