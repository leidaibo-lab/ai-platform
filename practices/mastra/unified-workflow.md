# 完整产研流程

2026-11-10 的[业务验收改造设计](./business-delivery-design.md)定义下一版澄清、交接和测试门禁，当前尚未接入；本文件下文继续描述现有运行图，不将设计状态计为实现完成。

本机可复跑示例见[工单交付闭环](./examples/local-delivery/README.md)：复用本主链的暂停恢复与质量门，补充实际静态发布和回滚执行者。固定模型、示例自动决策与真实机器观察分开记录。

2026-11-07 起，Studio业务主入口为 `productDevelopmentWorkflow`（内部 ID 为 `product-development`）；另注册六个具名开发独立评测Workflow，仅在隔离候选中考核单个角色。旧提案链、独立产品交接及修订入口从 Studio 移除；历史源文件与数据库保留，旧 CLI 仅作兼容。

日常操作按 [README](./README.md#启动)启动后端与前端，打开[产研工作台](http://127.0.0.1:4112/)；所有人工关口可在工作台完成。以下 Studio 图和 Resume JSON 供技术调试及契约查阅。

启动后端 `npm run dev`，打开 `http://127.0.0.1:4111/workflows/productDevelopmentWorkflow/graph`。首次输入 `{ "iterationId": "recruitment-001", "brief": "你的需求" }`；迭代未指定时默认 `unassigned`。图中的 Workflow 可展开查看产品、开发、测试与部署子步骤。主链保持一个 Run，各角色在自己的子流程内扩展。

```text
原始需求
  → guidedIntake=true 时：方案摘要 → 关键问题确认 → 回答后修订及业务成熟度检查（不设总轮数上限，每轮最多八题）
  → 总产品 → 需求梳理 → 产品闭环 → 产品写作
  → review-product：人工确认产品版本
  → confirm-project-scope：确认文件快照、可写范围和角色
  → prepare-context：读取项目上下文
  → architecture：接口契约、任务拆分、依赖图
  → assemble-agent-team：按任务动态组建团队
  → assess-readiness：独立就绪评估，必要时人工裁决
  → approve-architecture：确认方案、团队和权限
  → execute-agent-team：按依赖波次执行
       dispatch-ready-tasks
         → foreach execute-team-member，最多3个独立任务并行
             任务负责人 → delegateTask → 具名子 Agent 实际实现
         → merge-team-results：范围校验与合并
       未完成任务继续下一波次
  → development-self-check：固定工程检查
  → review-code：独立只读评审
  → assess-delivery：交付门
       通过 → development-delivery.v2
       缺陷 → 责任任务及其下游有界返工
       方案阻塞 → 重新规划、组队与批准
       新业务决定/扩大授权/预算耗尽 → 保存证据并升级人工
  → testing：独立测试子流程
       prepare-test-plan：测试角色读取需求与实际源码
       approve-test-cases：确认用例、预期、需求与登记检查映射
       execute-tests：隔离环境重跑登记套件
       execute-browser-qa：QA Agent 加载固定方法并执行批准浏览器用例
       review-test-results：补充人工用例结果，确认质量
       通过 → deployment
       缺陷 → route-test-defects → 原开发团队修复/自检/评审 → 重新测试
  → deployment：部署子流程
       prepare-release-plan：部署方案
       approve-release-scope：确认环境、制品、健康检查与回滚范围
       execute-release-externally：等待外部 CI/CD 实际执行回执
       verify-release-health：收集批准清单的全部健康结果
       失败 → execute-rollback-externally：等待外部回滚回执
  → confirm-final-delivery：汇总同版本证据，确认交付
```

产品、项目范围和方案在同一个原生 Run 中暂停与恢复。产品退回修改保存 `rework-requested` 终态，带反馈重新发起需求。开发模型故障保留失败任务和已合并的成功任务，连续故障后原阶段暂停，可多轮人工继续；不承诺强杀或跨实例的原子恢复。

开发阶段使用原生条件分支：只有当前阶段执行，未执行节点不会因空返回而完成。可恢复模型故障在原阶段暂停，页面解释阶段、原因和具体重试动作；历史 `recover-development` 暂停点保留兼容。连续自动尝试或调用额度耗尽会暂停等待恢复/追加额度，用户选择停止则保存阻塞终态；开发未交付时不启动测试/发布。图中 `state-after-*` 为状态传递节点，其完成不代表相邻业务阶段已完成。[状态决策](../../docs/decisions/2026-11-08-mastra-stage-state-flow.md)。

## 项目范围确认

当前 HRM 前端在 `confirm-project-scope` 确认关联项目、代码版本、确认人、交接说明及自主执行预算。服务端从固定仓库装配源码、源码根权限上界、只读检查文件和角色候选池；浏览器不能自报全栈执行档或上传源码替换基线。开发 Agent 决定具体文件、任务依赖及所需角色，动态团队由任务形成，仍需人工批准架构方案后才实施。

HRM 执行档为 `hrm-pnpm-docker-v1`，`planning=agent`。检查登记为 `project:check/build/smoke`，通过 Docker/Compose 在源码副本和临时数据库中运行 `pnpm check/build/smoke`；前两项禁网，smoke 仅连内部测试网络，不使用宿主 `.env`。新增文件限已授权源码根，依赖清单、锁和固定检查不可修改。当前 smoke 验证页面、API 与数据库健康，业务断言需后续随需求补充。

以下 JSON 保留为 CLI/Node fixture 兼容格式，不是当前 HRM 前端的填表要求。`files` 是显式提供的初始源码，`writablePaths` 是精确写权限，`checkFiles` 必须存在且不可写。旧执行器支持受限 Node `.mjs` 语法检查及登记的 Node 检查，不支持任意项目命令。

```json
{
  "project": {
    "id": "my-project",
    "files": {
      "src/frontend.mjs": "export const view = '';\n",
      "src/backend.mjs": "export const response = {};\n",
      "checks/contract.mjs": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { view } from '../src/frontend.mjs';\nimport { response } from '../src/backend.mjs';\ntest('frontend/backend contract', () => { assert.equal(typeof view, 'string'); assert.equal(typeof response, 'object'); });\n"
    },
    "writablePaths": ["src/frontend.mjs", "src/backend.mjs"],
    "checkFiles": ["checks/contract.mjs"],
    "roles": ["frontend", "backend"]
  },
  "reviewer": "项目负责人",
  "comment": "确认需求版本与文件授权",
  "maxReworks": 3,
  "autonomy": {
    "version": "autonomy.v1",
    "maxCheckRuns": 24,
    "maxNoProgress": 2
  }
}
```

示例只说明格式，不是实际业务验收。业务代码目标为 `leidaibo-lab/hrm`，执行器写独立候选目录，已接通整仓 pnpm 验证，已接通角色资料与候选源码副本的远端交付分支，尚未将候选代码合入业务源码分支。输入、候选文件保存在当前数据目录的 `development-runs/<Run标识散列>/`。原生 LibSQLStore 保存流程事实；候选目录不创建第二套审批库。授权人是本地标签，当前未接入认证。

## 团队、委派与数据边界

成员由任务包动态生成，包含 `id/role/taskId/paths`，团队参与批准包散列。前后端任务无依赖且文件无冲突时可同时执行；有依赖则等待前序合并。每个成员读取同一波次快照，在独立临时候选目录工作，屏障后由宿主校验并合并成功补丁。

任务负责人通过原生工具 `delegateTask` 创建子 Agent，自主选择已登记角色、目标和父任务路径子集。最多3次、深度1；子任务路径须无重叠且覆盖父任务。父成员无直接写工具，子成员无继续委派工具。委派目标、角色、路径、父子 ID 和输出/源码散列持久化；父子调用共用72次预算。任意角色、宿主文件、命令或无限递归未开放。

Zod schema 约束跨模块数据，步骤返回新状态；补丁映射按文件定位，完成任务按 ID 管理。工厂模式创建动态 Agent，执行作用域适配器隔离每个 Run 的 I/O，原生 Workflow 负责调度和持久化。自有适配只负责依赖波次、授权及补丁合并，不另建通用引擎。

## 批准范围内自主开发与排障

工作台新提交的项目范围显式绑定 `autonomy.v1`。需求、任务和实施范围批准后，团队连续完成实现、集成、常见错误修复和验证。预算在项目范围及方案批准时展示：默认最多3轮返工、累计72次开发模型调用、24次登记检查套件执行；连续2次与上一轮相同的失败签名判为无进展。首次失败建立基线，之后才累计重复。旧输入没有 `autonomy` 时保持原政策，不静默改变历史批准与恢复散列。

每次实际检查追加 `verificationHistory`，包含命令、退出码、脱敏有界输出、超时/截断标记、耗时、源码散列、角色、任务路径、轮次及用途。工具检查、合并后的独立复跑和独立测试分别绑定自己的候选版本；失败分支即使回滚补丁，也保留检查证据。`repairHistory` 保存失败签名、责任任务、问题分类和无进展次数；后续角色同时获得检查、返工、模型失败及既有评审记录。流程状态仍由原生 Store 保存，候选目录不成为第二套事实源。

实现者与任务负责人获得无参数 `runChecks` 工具，只能运行已登记检查，不能自填 shell 命令、修改检查文件或安装依赖。并发分支按剩余额度预分配检查次数，并预留2次给整体自检及宿主独立复跑；父子任务与失败重试共享分支账本。达到分配上限也会停止，因此停止时实际总次数可能小于总上限。分支检查不能代替合并后检查，模型吞掉工具预算异常也不能交付。

前后端等多责任代码缺陷在已批准团队内联合修复，依据角色、文件和任务引用重跑责任任务及依赖下游，保留无关完成任务。无法定位时保守重跑批准团队。范围内契约缺陷不重新请求方案批准；确实改变批准设计时才回到规划和批准。修复后重新运行全量登记检查和独立评审，旧发现须逐条复评。

临时网络/超时按既有5次尝试及退避处理；格式错误携带安全诊断有界修正。代码缺陷按当前证据返工，环境错误保留分类并仅在原执行环境和权限内排障。失败检查和未解决发现发生变化才视为新证据，单纯修改源码、时长或报告顺序不算进展。达到返工、检查、模型或无进展预算后升级人工；业务缺口与权限/完整性问题立即停止。工作台展示具体停止原因、已消耗次数和最近检查输出。检查/返工停止保存终态和候选，本次未增加该终态的任意续办入口；既有模型阶段暂停仍沿原恢复入口处理。

该闭环已覆盖真实 Workflow、隔离 Node 检查和持久化回归，尚未完成真实模型在 HRM 上的完整业务自主交付验收。独立测试用例批准、人工用例确认及发布审批/外部回执仍按各阶段约定处理。[选型、验收及剩余边界](../../docs/decisions/2026-11-09-mastra-autonomous-development.md)。

## 测试用例与质量确认

`testing` 消费研发交付与同一份候选源码，独立生成计划，不复制开发自检当作独立执行结果。`approve-test-cases` 的 Resume 示例：

```json
{
  "hash": "使用暂停信息中 plan.hash 的实际值",
  "decision": "approve",
  "reviewer": "测试负责人",
  "comment": "确认全部需求的正常、边界、异常覆盖",
  "cases": [{
    "id": "case-1",
    "requirementRefs": ["使用暂停信息中的实际需求ID"],
    "expected": "填写可检查的预期结果",
    "method": "registered-check",
    "checkRefs": ["使用 registeredChecks 中实际存在的检查ID"]
  }]
}
```

用例 ID 唯一，全部已批准需求须有映射。自动用例只能引用登记检查；人工用例使用 `method: "manual"` 和 `checkRefs: []`。覆盖的业务语义由测试负责人负责，检查引用不能证明未执行的路径。

实际套件执行后，`review-test-results` 暂停。Resume 含当前 `hash`、`decision: "pass" | "rework" | "stop"`、`reviewer`、`comment`、`manualResults`、`findings`。人工结果逐项填写 `{caseId,status,evidence}`，status 为 `passed/failed/blocked`；自动结果不能被人工覆盖。全部用例通过、固定套件成功且无缺陷才允许 `pass`。

返工需要具体 `findings`，结构沿用开发评审的 `id/category/severity/route/detail/refs/evidence`，引用必须属于当前需求/任务/文件证据，责任角色必须已登记。缺陷通过原开发继续入口修复，沿用累计返工和调用预算；修复后重新自检、评审和独立测试。`qualityHistory` 与 `developmentHistory` 保存旧测试及交付记录。业务、完整性问题或预算耗尽停止流程，不自动放行。

## 发布审批与外部回执

部署当前采用原生暂停和人工回填，没有远程执行 Adapter。部署角色生成方案后，`approve-release-scope` 的 Resume 包含 `hash`（暂停信息中的 `packageHash`）、`decision: "approve" | "stop"`、`reviewer`、`comment` 和 `scope`：

```json
{
  "environment": "staging",
  "artifactDigest": "实际制品的64位十六进制SHA256",
  "artifactRef": "外部制品的不可变引用",
  "rollbackArtifactRef": "已确认的回滚制品引用",
  "healthChecks": [{"id": "service-ready", "expected": "服务就绪且关键路径正常"}]
}
```

此对象放入 `scope` 字段。制品散列与源码散列分别记录；当前制品到源码的构建关系来自负责人确认，未进行 CI 机器校验。批准后，执行节点仅等待授权人员在外部 CI/CD 操作，不启动远程任务：

| 暂停节点 | Resume 字段 |
| --- | --- |
| `execute-release-externally` | `releaseHash/sourceHash/artifactDigest/environment` 精确复制暂停绑定；`status` 为 `succeeded/failed/cancelled`；另填 `jobRef/operator/finishedAt/notes` |
| `verify-release-health` | `releaseHash/deploymentReceiptHash/operator/checks`；每项检查含 `id/status/evidence/observedAt`，status 为 `passed/failed`，清单必须与批准范围完全一致 |
| `execute-rollback-externally` | `releaseHash/rollbackArtifactRef/status/jobRef/operator/notes`，status 为 `rolled-back/manual-attention` |

时间使用 ISO UTC，例如 `2026-11-07T08:00:00Z`。所有外部回执的 authority 为 `local-human-report`，本地操作者标签不等于认证身份。最终确认必须有同版本测试通过、发布成功和全部健康通过记录；失败则等待回滚并产生明确终态。

终态 `delivery-confirmed` 表示基于已收集证据确认交付，不表示远程机器独立验证；fixture 模式仅产生 `fixture-completed`。其他终态包括 `blocked/rework-exhausted/rejected/rolled-back/manual-attention`。产品审批前的拒绝/退回仍保留原产品状态结构。新图使用新 Run；旧 Run 不承诺跨版本透明续跑；仅对未实施的业务阻塞提供经过版本和源码校验的固定澄清入口，见[工作台契约](./guided-intake.md)。

采用锁定版本的原生 Workflow 嵌套与 `foreach concurrency`，未采用 Agent network 自由路由或自建通用调度引擎；原因、维护责任、退出及重评条件见[决策记录](../../docs/decisions/2026-11-07-mastra-unified-development-team.md)。

测试与部署的选型、人工回执边界和重评条件见[完整产研生命周期决策](../../docs/decisions/2026-11-07-mastra-full-delivery-lifecycle.md)。

## HRM 资产落地与资料来源（2026-11-07）

Studio 使用同级 `/Users/lei/code/hrm` checkout，或由进程变量 `MASTRA_HRM_REPOSITORY` 指定绝对路径，origin 必须匹配用户指定仓库。四产品角色改为只读该仓库 `product/sources/`。旧 CLI 与配对评测仍沿用原资料条件；不会自动把历史量表/评审开放给 Agent。

| 产物 | HRM 本地归档 |
| --- | --- |
| 产品稿、四角色输出、审批、项目范围、方案/任务/研发交接元数据 | `product/runs/<runId>/<stage>/<hash>/` |
| 测试计划、用例、结果、缺陷与历史 | `testSet/runs/<runId>/<stage>/<hash>/` |
| 发布方案、范围、发布/健康/回滚回执、最终状态 | `deploy/runs/<runId>/<stage>/<hash>/` |

宿主在角色关口暂停前/返回后导出，manifest 最后落盘，同版本不覆盖。导出失败节点显式失败，不能绕过失败宣称已归档；尚需真实 Run 验收失败后补归档和恢复。文件是交付投影，审批与恢复继续以原生 Store 为准。后端另提供 `hrm-product/hrm-testset/hrm-deploy` 三个只读文件视图。

来源清单为 `hrm/product/sources/manifest.json`，目前复制原始 brief 并登记出处/散列，pm-hrm 仅登记参考尚未加载。当前用户确认和本 Run 批准需求决定范围。`sources-observed-at-export.json` 只是归档时来源清单，不能证明生成时工具实际读取；逐 Run 冻结及工具引用仍是待办。

历史记录中的代码回库/全栈执行边界已由后续决策扩展；CI/制品、真实业务验收、历史 Run 补导出和恢复等剩余项见 `hrm/docs/delivery-assets.md` 与[资产决策](../../docs/decisions/2026-11-07-hrm-repository-assets.md)。

## 产物归档与查看（2026-11-07）

已将项目、迭代和根 Run 关联贯穿产品、开发、测试与发布；所有角色阶段的完成/暂停关口归档不可变文本投影。统一查看入口为 `http://127.0.0.1:4111/delivery-assets`，提供筛选、历史版本、纯文本预览、单文件和 JSON 包下载；工作台提交人工决定，原生 Workflow 与 Store 继续拥有审批事实和恢复。结构、接口、归档时机、实际限制与 SVG/PNG 数据流转图见[详细说明](./artifact-dataflow.md)。历史 Run 无关联时保留未关联状态，不自动归入本次迭代。


## 验证与历史证据

可靠性回归、架构续验与真实业务阶段结果见[检测记录](./evaluations/reliability/2026-11-07.md)；前端及 HTTP 关口验证见[工作台契约](./guided-intake.md)。固定模式通过不代表真实模型质量或实际部署通过，完整业务交付尚未验收。历次计数和阶段观察保存在[整理前快照](./unified-workflow-history-2026-11-07.md)，不作为当前测试总数。

## Agent 资源归属核对

当前资源、生产消费关系、版本绑定及配置权威入口见[资源衔接清单](./config/workflow-resources.json)与[边界说明](./config/README.md)。清单是审计快照，尚未被运行时加载。当前运行事实基本归原生Store，Agent间最小输入契约和统一资源配置仍有缺口，不能宣称完全解耦。


资源接入的具体定义已形成：[配置/冻结/最小输入契约](./config/runtime-resource-contract.md)与[JSON示例](./config/workflow.runtime.example.json)。本轮仅定义新版本与迁移规则，当前Workflow仍按现有实现运行；不能把配置示例或审计清单当作已生效能力。


## 原生评测面板

原生 Datasets、Scorers、Experiments 的用例与命令见[原生节点评测](./evaluations/native/README.md)、[开发独立节点评测](./evaluations/native/development-nodes/README.md)及[独立评审与缺陷返工专项](./evaluations/native/review-rework/README.md)。角色评测不代表动态团队、业务审批或发布路径已验收。

前端需求澄清、完整稿及全部后续人工关口见[工作台契约](./guided-intake.md)；直接使用 Studio 原始输入默认跳过澄清。

## 角色远端交接

2026-11-08：live 主流程绑定 HRM 时，角色阶段在远端同步成功后才交付下游；同步失败原生暂停，工作台仅重试同步。模型输入采用按任务资料目录、固定版本分段读取与消息预算；旧审批/源码恢复字段保留兼容。[具体边界](./artifact-dataflow.md#2026-11-08远端交接与按需上下文)及[决策记录](../../docs/decisions/2026-11-08-mastra-remote-handoff.md)。

浏览器用例使用 `method: browser`，同版本回执 authority 为 browser-process，人工不能覆盖机器失败。字段、安装与静态候选限制见[浏览器 QA 本地契约](./browser-qa.md)。

## 2026-11-09 测试通过后的源码回库

独立质量门通过 → `publish-tested-code` → 发布计划。live 的项目确认冻结 origin/基线 commit；开发阶段同步目标必须匹配项目。宿主读取实际候选、交叉验证研发/质量/批准版本，只提交批准任务内新增或修改的普通源码。Git 使用独立 index 和普通 push，同一根 Run 的资料与源码共用 `codex/workflow/<RunId>`。失败暂停在现有远端同步关口，重开 Store 后可复用原提交；重复执行不会重做模型或把远端回退。旧 Run 缺少基线、同步关闭、未提交工程基线或目标漂移时保持暂停，不能假报推送成功。`codePublication` 绑定远端 commit、sourceHash 和 qualityHash，发布流程必须消费同版本回执。

本轮本地 bare 远端和原生暂停恢复已验证，HRM GitHub push dry-run通过；实际业务候选的 GitHub 写入、自动合并与 CI 制品绑定尚未验收。见[回库决策](../../docs/decisions/2026-11-09-mastra-code-publication.md)和[评测报告](./evaluations/native/development-nodes/results-2026-11-09.md)。
