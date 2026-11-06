# 产品 Skill 配对评测

目标是回答：在相同模型、四个产品角色、固定路径和原始需求下，完整产品 Skill 包能否减少遗漏、提高人工首次通过率，且增加多少审阅和模型成本。此处是小规模 pilot，不是生产质量基线。

首轮执行见[2026-11-06 真实模型观察](./observations-2026-11-06.md)：六次尝试，五份待审稿、一份超时失败；人评待填，不代表已验证质量提升。

## 比较范围

两组均走正式入口与原生 Workflow：总产品 → 需求梳理 → 产品闭环 → 产品写作 → 产品人工暂停点。角色职责、原始输入、共同任务规范、事实边界、practiceInfo 工具及每角色 24 步上限一致；没有人工反馈、返工或下游开发参与首稿生成。

- without-skills：不挂载产品 Skill，不注入 Skill 加载、优先清单和方法引用指引。
- with-skills：挂载完整 113 项产品 Skill，并保留正式选法、渐进读取和交接检查指引。

这测量的是“方法资产及其调用指引”的整体增量，不能归因于某一项 Skill，也不能把调用过方法等同于正确执行了方法。原有角色提示中的产品知识保留，两组都具有完整 Agent 工作能力。正式应用默认仍启用 Skill，实验开关只在内部装配使用。

采样固定为 temperature=0、maxOutputTokens=4096、maxRetries=0；每角色 totalMs=180000、stepMs=90000，串行运行，相邻配对交替先后顺序。总 token 不强行相等，因为多步读取和上下文增加本身就是待测成本。采样参数是请求设置，不保证供应商完全确定性或在背后固定路由；因此记录响应 modelId，模型信息缺失或漂移时不计算配对差值。

## 固定样本与人工标准

[inputs.json](./inputs.json) 只包含业务输入。[rubric.json](./rubric.json) 是独立人工量表，脚本不将其传给 Agent，也不读历史项目评审答案。

| 案例 | 目的 | 输入状态 |
| --- | --- | --- |
| recruitment | 真实招聘诉求的范围、协作、业务审批与产研审批边界 | 与项目原始 brief 字节一致；缺少业务决定 |
| title-validation | Unicode 码点、trim、API 一致性、失败保留及历史兼容 | 合成完整规则，可观察首稿放行 |
| meeting-cancellation | 权限、状态、释放、幂等和未决业务选择 | 合成模糊需求，必须识别待确认项 |

模糊需求可能因原始业务决定缺失而无法进入开发，两组都应如实保留阻塞；因此不能仅凭首次通过率判定方法无效。必须结合遗漏、错误和具体阻塞项审阅。真实样本不足 30 对时仅作观察；本 pilot 只有 3 对，不做显著性或发布结论。相同需求重复生成不能冒充独立业务样本。

## 显式使用 Workspace 资料

默认实验禁用 Workspace，保留原始 brief 输入条件。使用 `npm run eval:product-skills -- --workspace --cases recruitment` 可另做资料条件下的对比：运行前将项目 `sources/` 冻结到 `organizer/sources/`，manifest 登记资料散列，两组挂载同一只读快照。评分量表不进入 Agent，步骤计量记录实际文件工具调用；fixture 不保证模型选择读取文件，也不代表质量提升。资料条件和默认条件不能混为同一实验。结果可在 Studio 的 `product-evaluations` Workspace 查看；组织者全量可见，人工审阅者只拿 `review/`。详见 [Workspace 契约](../../workspaces.md)。

## 指标口径

| 指标 | 分子/分母或计算 | 缺失与失败 |
| --- | --- | --- |
| 需求遗漏 | 人工标 missing 条目数 / 已完整审阅的固定量表条目总数 | 未评为 null；incorrect 单列，附加缺陷保留 |
| 人工首次通过率 | 可进入下一阶段的首稿数 / 已完整人工审阅的首稿数 | 严重缺陷与通过冲突时仍为待核实，不自动放行 |
| 审阅时间 | 人工主动阅读原始诉求、稿件、评分和做首稿决定的秒数 | 不含暂停、生成或返工；未评为 null |
| 模型成本 | 所有四角色、所有模型步骤的输入/输出 token；有带来源单价时估算 USD | usage 缺失/失败计量只给已知下界；不当作免费 |

模型生成耗时单独记录 elapsedMs，不用它代替人工审阅时间。即使请求配置 maxRetries=0，实际仍可能观察到 Mastra 原生 retry 步骤；以真实记录为准，不因未返回 usage 而把该次尝试当作免费。失败、未开始、已生成和已人工审阅数量均保留。分组统计只是描述；主比较使用同案例同轮次、双方生成成功、实际模型一致的配对，人工差值还要求双方人工审阅完整。差值方向为 with − without；遗漏、审阅时间和费用下降为负，首次通过提升为正。

人工量表每项需有正文依据，missing/incorrect 不能留空证据。没有依据或存在重大评分冲突时不算完整审阅。生成失败不填人工评分、不删除计划项；样本稀少时更不能只挑成功稿报告改善。美元费用须使用实际响应模型对应的供应商价格，明确 cache read 单价；缓存量缺失且价差存在时费用仍为 null。token 不是发票金额，网关重试或不可见失败调用可能产生额外费用。

## 执行与人工交接

在 practices/mastra 下使用 Node.js 24：

```bash
npm run check
npm test
npm run eval:product-skills
npm run eval:product-skills -- --live --out .data/evaluations/product-skills-pilot
```

默认 fixture 只验证执行和计量管道，不代表真实模型质量。live 复用本实践的配置加载入口读取凭据，不打印凭据，所有 Workflow 使用新建的独立数据库；不接入已有审阅 Run。可用 --cases recruitment 缩小样本，或 --rounds 2 观察生成波动，最多五轮。输出目录必须为 .data/evaluations/<新目录>，既有目录不会覆盖。

每次运行生成：

- organizer/manifest.json：模型与采样参数、角色提示原文、代码/依赖锁和 Skill 资源散列、输入和量表版本；不保存 API key、上游地址或响应头。
- organizer/trials.json：事先创建的完整计划、分组映射、逐步用量、方法调用、四角色产物、原稿、原生 Run ID、耗时和失败分类；每完成一个样本落盘一次。
- organizer/<sampleId>/workflow.db：该样本的原生快照，只由组织者保管。
- review/：匿名编号稿件、独立量表、随机审阅顺序和人工填写表，所有人工指标初值为 null；[审阅指引](./reviewer-guide.md)。
- organizer/report.json：可重复汇总的结果；未完成审阅不生成质量结论。

只将 review/ 交给人工审阅者。正文方法引用可能泄露组别，不承诺完全盲法；同一人看同题稿也可能有学习效应，首稿决定应先锁定再阅读配对稿。团队后续扩展可使用不同审阅者交叉复核。脚本不删改方法附录以伪装盲审。

填写 review/reviews.json 后汇总：

```bash
npm run eval:product-skills -- --report .data/evaluations/product-skills-pilot
npm run eval:product-skills -- --report .data/evaluations/product-skills-pilot --pricing .data/evaluations/pricing.json
```

可选 pricing.json 结构为 source（报价来源）、date（YYYY-MM-DD）、models（以实际响应 modelId 为 key）。每个模型需要 input、cachedInput、output 三项非负数字，单位为 USD/百万 token；不提供默认价格。当前脚本不读取账单或按模型别名推测价格。

## 实现依据和边界

沿用[固定角色决策](../../../../docs/decisions/2026-11-06-mastra-fixed-product-roles.md)。锁定 @mastra/core 1.81.0、@mastra/libsql 1.28.0、ai 7.0.162，通过 Agent 原生 defaultOptions/onStepFinish 和正式 startDelivery/Workflow/LibSQLStore 执行。人工指标无需模型 Judge，因此使用原生运行入口与外部量表；未引入另一套调度器、自动评分服务或评测依赖。API 依据为安装包 dist/docs/references/reference-agents-generate.md 与对应类型，线上资料版本不一致时以锁定版本为准。

应用只拥有开关、白名单测量投影、输入资产、人工量表和 JSON 汇总，维护者为本实践维护者。核心数据由 TrialEntry、TrialResult、MeasuredStep、HumanReview 定义：计划有序；result=null 表示尚未执行；usage=null 表示未报告；人评字段 null 表示待评；每次汇总返回新投影。沿用工厂与薄适配器，不新增泛化引擎。外部 I/O、模型执行和指标汇总分离，保持单一职责。

不修改探索主线契约，无新增依赖。删除专用脚本、资产和工厂的可选测量参数即可退出；保留 Markdown、JSON 和原生库作为证据。当需要大样本、多审阅者、在线审阅计时、可靠恢复或平台发布门禁时重新评估原生 runEvals、数据集和人工评测平台，不将此 pilot 直接扩成公共评测框架。
