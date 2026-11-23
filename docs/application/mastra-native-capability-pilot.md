# Mastra 原生能力隔离试点

本项目默认启用本地最小化 Trace；服务端 `.env` 可设置 `MASTRA_LOCAL_TRACE=false` 并重启以关闭。Trace 写入配置的数据目录中的 Mastra Store；只接受文件或内存 Store，不添加远端导出器。关闭开关不会删除已保存的数据；Trace 仍受本机数据目录和 Studio 的现有访问控制约束。Store、暂停和审批事实仍是原有权威来源。

本试点为平台开发者提供可重复的版本兼容证据。运行：

```bash
npx tsx --test tests/mastra-native-pilot.test.ts
```

测试使用合成数据、fixture 模型和隔离 LibSQL，不访问远端。`@mastra/observability` 固定为运行依赖；对照试验发现仅使用 `SensitiveDataFilter` 时，实际平台 fixture Workflow 的合成需求正文仍出现在 Trace 中，因此主线使用下述允许字段策略，而不单独依赖该过滤器。

Agent Experiment 验证声明的工具替身实际返回给模型、真实工具未执行，以及 `unmockedToolPolicy: 'deny'` 拒绝未声明工具。此机制仅适用于 Agent 目标；现有研发单节点评测使用 Workflow 目标，评审返工专项使用自定义 task，不可直接声明工具替身后声称已拦截。数据项可覆盖实验级策略，实际使用前须校验每项配置。

最小 Agent 的固定模型试点可运行 `npm run eval:product-tool-mock`。它使用最小 Agent、隔离内存 Store、声明的 `practiceInfo` 替身和拒绝未声明工具策略；结果只证明工具替身机制，不代表模型质量或产品验收。

最小化策略按允许字段重新构造 Span，保留框架标识、时间、类型、UUID Run 关联与固定错误标记，丢弃正文、工具参数、输出、异常详情、预览和任意属性。隔离 fixture 已验证产品写作与独立审查动态装配的 Agent 与工具出现在 Workflow 的同一 Trace，且工具位于 Agent 子树；测试同时覆盖需求正文、合成错误以及工具输入输出的过滤。需求澄清、业务阻塞回流及研发 Agent 的动态装配路径尚未完成同样验证。

当前版本 `MastraStorageExporter` 的 `customSpanFormatter` 异常时回退原始 Span；单靠格式化器不能保证失败关闭。主线使用只订阅 Trace 的导出包装，过滤异常时丢弃事件，不把日志、指标、评分或反馈交给该导出器。隔离测试验证过滤异常、主线 Store 重开读取和暂停后恢复；不保证进程崩溃时已缓冲的 Trace 一定落盘。

实时流试点表明，同一 Workflow 实例中以同 Run ID 获取的对象能使用 `observeStream()` 读取已启动流；尚未验证跨进程、服务重启、暂停恢复或丢包重放。现有 `watch()` 与浏览器白名单投影继续保留。

当前安装版本的文档指出 LibSQL 不支持观测指标聚合；Trace 可写入不代表费用汇总或 `TokenCostControl` 可用。费用控制还受指标异步写入与模型定价覆盖影响，不能替代调用次数等硬预算。

采集不会自动清理；当前 LibSQL 支持按表设置保留期并显式执行 `prune()`，但其执行会删除数据，本项目未设置期限或自动调用。需由用户按现有数据维护方式管理，禁止未经授权删除。当前应用仅监听 `127.0.0.1`，多项目共用 Store；项目身份绑定不是租户认证，尚未证明 Studio 原生 Trace 接口按项目隔离。共享主机或多用户环境不能据此视为具备项目级访问隔离。真实模型、业务数据、跨进程 Trace 关联和外部服务均不在本次验证范围内。
