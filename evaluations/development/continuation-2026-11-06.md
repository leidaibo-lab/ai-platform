# 研发续办记录（2026-11-06）

## 修复范围与验证

本次继续原[中断与续办清单](./observations-2026-11-06.md#v3复测中断与续办todo)，保留所有历史批次与trial。沿用Mastra原生Workflow、Store、Agent和文件检查点Adapter，没有引入新框架或扩大Agent执行权限，也不改变探索主线OpenSpec。

- 架构返工方案形成后清除重规划标记；自检/实现故障接续按已保存任务进度继续，新架构仍须重新批准。
- 执行身份包含mode、modelId和规范化endpoint摘要，绑定方案/恢复hash。模型/端点漂移在resume前拒绝并保留暂停点，key轮转允许；旧快照身份缺失时禁止继续执行。
- 评测自动批准校验来源类型、evaluation-input证据与正文SHA256；真实产品来源不能使用组织者合成批准。
- SDK finishReason=error只提取安全分类，原始请求/响应和异常cause不进入Workflow日志。无效任务图属于invalid-output，不作瞬时重试。
- 本地真实SDK401、503和连接重置均保存安全类别；后两类最多两次HTTP请求。额外发现并关闭Mastra默认错误处理器重试，固定SDK和processor重试均为0，仅保留Adapter的一次检查点重试。

使用本机捆绑Node **24.22.1**：`npm test` **99/99**、`npm run check`及OpenSpec strict **1/1**通过。已激活`tests/development-recovery-review.test.ts`，包含原保留6例及执行身份归一化、key轮转、方案审批漂移补验；Node用例超时和Adapter进程强制终止回归也已实际执行通过。Linux bwrap仍未验证。

## 新v3完整实测

输出目录：`.data/evaluations/development-live-v3-recovery-fixed-2026-11-06/`，独立预登记24例×2轮，四路并发，使用当前v3公开输入。manifest冻结输入、oracle、量表、实现、配置加载器、依赖锁及提示词散列，并记录executionIdentity；不复用中断批次的交付物。

```bash
npm run eval:development -- --live --rounds 2 --concurrency 4 --out .data/evaluations/development-live-v3-recovery-fixed-2026-11-06
```

本次从北京时间 **2026-11-06 21:49:40.959 至 22:09:17.153**，墙钟约19分36秒；四路并发，各trial累计耗时约75分16秒。使用Node24.22.1，请求模型`openai/gpt-6-astra`，129条成功角色返回均报告实际模型`gpt-6-astra`。批次结束后核对11个实现/配置/锁文件散列及输入、oracle、量表散列，全部与manifest一致；额外汇总保存在同目录`analysis.json`，原始`trials.json`不回写。

| 结果 | 第一轮（24） | 第二轮（24） | 合计（48） |
| --- | ---: | ---: | ---: |
| 交付包且隐藏行为检查通过 | 21 | 20 | 41 |
| 预期歧义澄清 | 2 | 2 | 4 |
| 预期交付却提出澄清 | 1 | 1 | 2 |
| 模型调用故障暂停 | 0 | 1 | 1 |
| 未开始/运行中 | 0 | 0 | 0 |

`report.json`的generated=47包含41次交付和6次澄清，不能把47理解为交付通过数。41次交付共139条隐藏断言通过，无已交付候选断言失败；实现目标交付为41/44。四次预期澄清没有函数断言，其语义是否正确仍须人评。按预期结果自动对齐为45/48，仅作行为观察，不是能力通过率；六维人评 **0/48**，`capabilityPassed`与`admission`保持null。

两轮有3/24案例的结果类别不一致：`crud-02`由交付变为故障暂停；`file-02`由澄清变为交付；`api-02`由交付变为澄清。19个实现案例两轮均交付，另2个预期歧义案例两轮均澄清。安全/数据关键案例共18次，其中17次交付通过、1次为`file-02-r1`澄清，因此不能宣称关键项已全部通过。

- `file-02-r1`询问organizationId是否只接受非空字符串及纯空白是否有效。
- `api-02-r2`询问page/limit是否允许前导零。
- 两项额外澄清不据隐藏答案反向补规则，也不挑选重跑；需要独立审阅输入充分性和模型是否过度澄清。
- `crud-02-r2`在架构阶段首次`model-network`、重试后`model-error`，成功恢复文件检查点并停在原生恢复关口；评测不进行人工接续，完整失败计入48项。

共记录5次失败调用：3次model-network、1次model-timeout、1次model-error；其中3个trial在一次自动重试后完成，另1个trial耗尽重试后暂停。所有41次交付在首轮固定自检通过，未发生开发返工；这不能替代专门的返工/恢复回归。129条成功角色返回包含architect47、backend29、frontend12、self-check41；已知input tokens **1,970,131**、output tokens **82,526**，合计 **2,052,657**。5次失败调用用量未知，以上是可观测下界，不能当作完整计费量。

## 全栈agent-v1

主批次结束后在独立目录`.data/evaluations/development-stack-agent-v1-2026-11-06/`完成一次真实Agent生成和容器构建尝试，命令为：

```bash
node --import tsx scripts/development-stack-eval.ts --source agent --live --docker-context desktop-linux --out .data/evaluations/development-stack-agent-v1-2026-11-06
```

Node24.22.1组织执行，Docker Desktop引擎29.5.3。4条成功角色返回为架构1、后端2、前端1，实际模型均为`gpt-6-astra`；输入91,027 tokens、输出5,358 tokens。后端/前端实际调用readFile/writeFile，3次writeFile分别完成`api/tickets.service.ts`、`api/tickets.controller.ts`、`app/page.tsx`。源码树hash为`eac8ec99dd81c7b2d163bec56f972579be1eb95c73431d607760135a8b29112d`；核对候选hash仅这三个白名单文件变化，其余主持装配未变，差异保存为`candidate.patch`。此入口是角色生成加主持固定容器检查，不将其称为完整Workflow的人工批准或开发自检。

实际结果：`outcome=failed`、`phase=build`、`cleanup=true`。Docker在拉取Node基础镜像元数据时向Docker Hub申请匿名token遇到TCP连接超时，build退出1，尚未运行npm ci、候选禁网编译、迁移、API/页面HTTP检查或重启持久化。因此本轮只证明真实Agent生成了候选，**不能判定编译或功能质量，也不能与主持基准v4的运行通过数作能力比较**。固定Dockerfile仍约束候选编译使用`RUN --network=none`，Compose仍为internal网络、无宿主挂载，但本轮尚未执行到这些候选运行阶段。

独立预取也记录环境失败：node首轮Docker Hub token TLS超时；postgres首轮下载short read/unexpected EOF。agent-v1失败后结束本轮仍在等待的两项镜像预取，退出143，保留部分缓存和全部日志至该目录；不修改全局Docker context、不停止既有引擎。`commands.json`、`build.log`、`environment-downloads.json`、`analysis.json`与原始报告共同保留失败和清理证据。复核本次project无遗留容器、网络、卷或候选镜像；未触及其他项目资源。浏览器仍为`not-executed`，humanScore/capabilityAdmission保持null。

## 剩余任务

- [x] 完整登记本次48项结果、隐藏断言、重复波动、失败和可观测用量。
- [x] 在独立目录执行全栈agent-v1，记录真实候选、环境失败及清理；与主持基准分开报告。
- [ ] Docker Hub可用后只对已保存agent-v1候选另建验收证据，不重新生成挑成功；补构建、迁移、API与重启持久化结果。
- [ ] 真实浏览器表单与窄视口交互；未执行前保持not-executed。
- [ ] 独立负责人完成需求澄清语义审阅及所有真实模型案例六维人评。

本机运行的Docker引擎为desktop-linux，没有colima context。全栈脚本增加显式`--docker-context`并保存实际命令，不改变全局context；生成前先检查引擎，依旧使用internal网络、无宿主挂载和禁网候选构建。整栈生成已完成、运行验收受镜像仓库故障阻塞；结果独立登记，不计入函数切片成绩。
