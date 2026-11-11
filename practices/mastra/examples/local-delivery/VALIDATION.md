# 本机闭环执行记录

2026-11-09 19:35（Asia/Shanghai），Node.js 24.19.0，@mastra/core 1.81.0、Playwright 1.65.0。执行 `scripts/local-delivery.ts all`，未加载 `.env` 或调用远程模型。

| 场景 | 实际观察 | 主链终态 | 示例结论 |
| --- | --- | --- | --- |
| success | 8个暂停点分别关闭Store后恢复；独立检查2项通过（语法及包含3项行为测试的套件）；浏览器3例全部通过且有截图；发布200、制品字节摘要及交互匹配；恢复v0演练200且页面匹配 | fixture-completed | passed |
| health-failure | 9个暂停点分别关闭Store后恢复；同样通过独立检查和3例浏览器QA；发布后实际503；主链触发回滚，恢复v0后200、摘要和页面匹配 | rolled-back | passed |

两条路径均有9条角色执行记录，包含真实 skill/skill_read、readFile/writeFile、delegateTask、runChecks；QA独立调用runBrowserCase。每次运行结束已关闭HTTP服务与浏览器。角色文本、就绪与评审结论为固定模型输出；人工关口由evaluation-policy提交，不能据此宣称真实业务质量或真实人工验收。

- 正常路径 Run：`2806bcda-e369-40bf-a528-c6a094fcb715`。
- 故障路径 Run：`6567e744-ba08-41b8-821f-d332b876fcca`。
- 候选源码集合hash：`78499c0c4a6f409899f92a03859ee26def1d8110ec80c761b130948d7ad852b1`。
- page.html制品SHA256：`661016b1dedec8d5e7fe5e0264d408ad04eb9e6b3d2a386c4afe81b3b35a1f06`。
- 本次完整证据：实践目录 `.data/examples/local-delivery/2026-11-09T11-34-58-788Z/{success,health-failure}/`；生成数据被Git忽略，其他环境需要重新运行。
- `tests/local-delivery.test.ts`：3项通过，0失败/跳过，含真实两条主链、制品漂移拒绝、HTTP路径/方法限制和退出后端口释放断言。
- 后端TypeScript检查通过；`openspec validate --specs --strict`：1项通过；`git diff --check`通过。未复用其他任务的全量测试计数。

首次试跑暴露交付对象 `files` 保存摘要而非正文；发布探测拒绝把摘要字符串当页面。示例构建已改为读取实际候选，前后校验源码hash并核对交付摘要，再按真实页面字节生成制品。正式Workflow行为未因示例改变。

本记录证明固定需求、固定模型驱动下，本机静态交付及故障回滚的工程链路已跑通。真实模型自主实现、HRM全栈、PR/CI、远程发布、认证审批和生产可靠性仍未验收。
