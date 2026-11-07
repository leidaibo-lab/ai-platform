# 六类开发节点独立评测

六个独立Dataset分别绑定同名职责的原生评测Workflow，使用正式`generateV2`、当前注册的Skill、受限文件工具和OS沙箱。可直接从Studio的Datasets发起Experiment、查看逐例输出/源码/检查/分数及历史；不是只导入历史报告，也不需要先跑完整产品流程。

业务仍只有`productDevelopmentWorkflow`一条主入口。新增六个带“开发…评测”名称的Workflow仅用于隔离考核：输入只允许已登记caseId、模式及用例散列，不接受任意源码、shell或批准，也不会进入部署、动态组队或业务交付。

## 用例与目标

[cases.v1.json](./cases.v1.json)共18例，每类3例。所有上游数据为明确标记的合成冻结输入，单次只调用当前角色。标准`expected`不发送给被测Agent；模型只看到该角色的真实输入文件、需求、固定计划及允许引用。

| 数据集 | Studio Workflow目标 | 三类用例 | 主要判据 |
| --- | --- | --- | --- |
| 开发上下文 | developmentContextEvaluation | 来源核实、缺失规则、不可信文档 | schema、合法来源引用、未知项、禁止越界读取/写入 |
| 开发架构 | developmentArchitectureEvaluation | 完整需求、缺失规则、冲突规则 | 正式方案校验器、任务/依赖/引用、计数契约、正确阻断 |
| 开发就绪 | developmentReadinessEvaluation | 可开工、业务口径缺失、契约冲突 | 正式评估校验器、无误报、具体发现/正确归属/阻断严重度 |
| 开发实现 | developmentImplementationEvaluation | 从占位实现、Unicode修复、类型修复 | 实际写入、固定检查、独立目录3类业务断言、输入与文件边界 |
| 开发自检 | developmentSelfCheckEvaluation | 通过、行为失败、语法失败 | 必须真实调用runChecks；报告状态及失败ID与实际结果一致 |
| 开发代码评审 | developmentReviewEvaluation | 正确代码、Unicode缺陷、类型缺陷 | schema/引用覆盖、禁止改源码、缺陷发现、backend归属与高/阻断严重度 |

代码评审的缺陷案例使用可通过的普通smoke，以验证能否从源码发现普通检查之外的缺陷；正确代码案例提供完整登记检查，避免把已知能力缺口混成业务缺陷。自检不能拿宿主独立复跑冒充自己执行：两类检查证据分别保存。

## 执行

在`practices/mastra`，使用Node24+运行：

```sh
# 导入当前服务模式的六个Dataset，不调用模型
npm run eval:development-nodes:seed

# fixture验证链路；固定模型不做业务推理，低分保留原样
npm run eval:development-nodes -- --run

# 真实模型首轮；与Studio使用同一个原生Store
npm run eval:development-nodes -- --live --run

# live持续考核：缺评分、执行/持久化错误、任一0分退出非零
npm run eval:development-nodes -- --live --run --strict
```

Studio默认模式来自实践原有配置。要在面板直接执行live用例，服务也须以live模式启动，例如`MASTRA_MODE=live npm run dev`；fixture/live输入相互拒绝。仅查看已保存的live结果不需要改变服务模式。不能把从fixture服务误发live输入的失败视为模型退化。

用例内容散列和模式进入Dataset身份；externalId使同版导入幂等。原生输入绑定suiteHash，旧版输入不能静默套用新用例。源码/依赖散列、方法包散列、模型配置ID、Git revision/dirty和用例版本写入CLI实验metadata。面板手动运行沿用当前服务配置，不自动具备CLI全部metadata，正式比较应确认源码与模型一致。

## 判定与边界

共享原生`development-node-evidence-v1`评分器从原始节点产物重新判定，任一硬条件不满足为0，reason列出问题，不能以其他项均值抵消代码失败。实验completed只代表结束，必须另查评分；故障、格式错误和越界尝试也保留。

实现的独立oracle固定类型、空白、长度与Unicode三个具名测试组，必须有完整执行计数、实际进程和宿主退出码及无截断/超时证据。自检在评测协议中额外要求输出`status/failedCheckIds` JSON；不改变正式自检Agent的工具权限或业务流程。

结构与引用校验复用正式`validatePlanV2/validateAssessment`。缺陷/阻断的类别、归属、严重度及预登记词项组成确定性检查，但关键词不是完整语义证明。上下文来源合法不等于所有规则均事实正确；架构中包含Unicode不等于完整方案合理；最终仍需人工语义抽查。首批案例不是完整业务域、全栈代码能力或生产准入。

本次采用Mastra原生Workflow/Dataset/Scorer/Experiment与现有执行器。未引入外部评测平台，未自建评测引擎；自有适配仅负责冻结上游、单角色装配、实际I/O记录和业务断言。原生Store持有事实，临时目录执行结束清理，返回证据保留源码快照；未接入探索主线Runtime，不改变其OpenSpec稳定契约。维护责任归Mastra实践维护者；需要动态团队、复杂仓库命令、跨实例恢复或更强语义评分时重新评估。

数据结构使用Zod约束用例、StateV2和节点输出；默认返回新证据，工具尝试在当前节点局部数组记录。沿用工厂/适配器模式，读取/写入/检查均由现有ExecutionPort隔离，评分器与模型生成分开，避免新增批准或状态库。

## 验证记录

- 六组18例fixture原生Experiment完成，结果及评分已持久化；fixture不代表能力通过。
- 专项19项测试通过：六类合成正确答案的真实I/O校验、错误引用、漏检/误放行、错误归属、源码篡改、未执行检查、空oracle、用例/模式漂移及六类原生Workflow执行/幂等导入。
- Studio原生API已读取六个Workflow、Dataset绑定及评分器；图形界面未做目视验收。
- 真实模型首轮与全量回归结束后另记结果；不预填通过结论。
