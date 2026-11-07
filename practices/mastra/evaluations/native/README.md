# Mastra 原生节点评测

测试用例由仓库 [nodes.v1.json](./nodes.v1.json) 管理，使用当前锁定的 `@mastra/core 1.81.0` 原生 Dataset、Scorer、Experiment API。Studio 注册评分器，实验与分数写入同一 `LibSQLStore`，没有额外评测页面、数据库或评测引擎。应用实践内采用原生能力，不改变探索主线稳定契约。

## 使用

在 `practices/mastra` 运行：

```sh
npm run eval:native:seed
npm run dev
```

开发启动启用Mastra原生`MASTRA_AUTO_DETECT_URL=true`，让Studio使用当前页面origin访问API，避免内置浏览器中localhost与127.0.0.1混用。若曾在Settings保存旧实例地址，点击错误页的`Reset Studio configuration`清除该覆盖。

打开 [Studio](http://localhost:4111)，进入 **Datasets**，选择带 `native-nodes.v1` 的数据集。数据集已关联正式 Agent 和评分器。运行 Experiment，在 **Experiments** 查看逐例输入、输出、分数、理由与历史对比；评分器在 **Scorers** 可查。当前模式由实践原有配置决定，默认导入不调用模型。

```sh
# 同一Studio数据库执行全部节点；每次追加原生Experiment
npm run eval:native -- --run

# 在已配置live模式时，用于CI质量考核；模型与裁判均产生真实调用
npm run eval:native -- --run --strict
```

`--run` 要求实验完成、执行/持久化/评分无错误；它不把“执行完成”当作质量合格。`--strict` 额外要求全部评分为1，任一未达标退出非零；只允许live模式，fixture不能充当语义准入。可由现有CI在相关Prompt、Skill、模型或实现变更时触发，本轮未新增定时任务或CI配置。

## 用例、判定与版本

首批6组18例：总产品、需求梳理、产品闭环、产品写作、独立测试、部署方案；每组包含明确需求、缺失业务决定、冲突规则。每例只有冻结input发送给被测Agent，groundTruth留在评分侧。

- `node-contract-coverage-v1`：确定性词项覆盖，缺标准/空输出得0分；不证明业务语义正确，也不检查实际代码行为。
- `node-quality-rubric-v2`：live模式默认注册并绑定新数据集，补齐工具执行证据；v1保留历史定义。裁判逐条检查职责、业务规则和事实边界，保存证据；要求返回完整原序标准，缺项不得抬高均分。裁判使用当前配置模型的独立调用，仍需人工抽查与校准，真实模型初始基线见下方续验报告，仍不代表独立人评准入。
- fixture只执行固定模型和确定性评分，低分应保留原样，不修改预期来制造通过。
- 当前节点输入为明确需求、歧义、冲突的初始集，不代表六类场景已经全覆盖。

数据集身份包含资产版本、导入模式和内容散列；原生externalId使同版导入幂等。修改用例会创建新的内容版本，保留旧数据集与实验。重复运行同一数据集可直接对比；跨数据版本的项目身份可能变化，不能把缺失对齐当退步。

CLI实验记录代码revision、dirty状态、模型配置ID、两份角色/指令源文件的promptSourceHash和用例sourceHash。该指令散列不覆盖完整Skill与依赖树；严格可复现的正式基线应在干净提交上执行并锁定依赖与Skill。fixture记录中的模型配置ID不是实际调用模型。Studio手动创建的实验不自动具备CLI的全部metadata，比较时需核对运行配置；切换fixture/live后应重新导入对应模式数据集，不混用历史模式。

## 范围与维护

六类固定开发节点现已通过[独立数据集与评测Workflow](./development-nodes/README.md)接入原生Experiment；动态组队、完整审批/恢复链仍由已有流程回归与专项评测覆盖。本轮不宣称产品和开发全节点已完成考核，也不把测试Agent的文本质量当作业务代码测试通过。原生异步评分不替代业务批准或交付门。

选择原生Dataset/Experiment而非仅保存专用JSON报告，是为了在Studio直接复用结果、版本与对比能力；未采用外部评测平台或另建看板，以保持当前原生实践的状态归属。自有代码仅维护业务用例、评分规则和导入/执行脚本。维护责任归Mastra实践维护者；删除装配中的scorers及专用脚本即可停止接入，历史事实继续留在原生Store。需要动态开发节点全覆盖、裁判校准、跨版本归因或更严格基线时重评。

## 2026-11-07 验证

- TypeScript检查通过；新增2项测试通过，覆盖空输出/缺标准、工具文本不能冒充助手正文、幂等导入、正式Agent实验、评分持久化、关闭/重开Store后的历史对比。
- 新增测试与相关产品回归合计12/12通过。
- 当前Studio数据库已导入6组18例，首轮fixture实验6次全部完成，执行和持久化失败均为0；不代表质量满分。
- Studio原生API已读取数据集与注册评分器，并通过原生实验启动API完成3例fixture实验，结果及分数可读取。
- 浏览器控制连接超时，未完成图形界面目视验收。
- 全实践回归存在失败；单独重跑未修改的执行器测试复现：当前Homebrew Node 25动态依赖`libuv`被现有OS沙箱阻断，退出128，并引发开发/返工链失败。未扩大本次范围修改沙箱；不报告全量回归通过。

## 固定流程真实模型基线续验

沙箱阻塞修复、固定开发三个小样本、原生证据导入及真实角色评测见[2026-11-07基线报告](./baseline-2026-11-07.md)。该续验更新当前状态，前面的fixture与阻塞记录保留为历史事实。

复评分命令：`MASTRA_MODE=live npm run eval:native:rescore`。它只对首次live实验的已持久化Agent输出调用v2裁判，不重跑Agent；原生Experiment的metadata绑定原实验ID。旧v1数据集保留，新live导入的数据集ID以`rubric-v2`区分，避免幂等导入覆盖既有评分绑定。


## 固定评审与返工专项续验

已补[固定专项](./review-rework/README.md)，冻结上游并分别验证干净对照、缺陷发现及真实修复、持续缺陷预算耗尽。实际结果与完整边界以专项记录为准，不把固定夹具或证据导入当作全链真实执行。

新增开发独立节点入口：`npm run eval:development-nodes:seed`导入六组18例；`npm run eval:development-nodes -- --live --run`执行正式单角色模型与真实沙箱。它与首批产品等六角色分开，不再用三项开发流程案例代替开发角色逐节点考核。
