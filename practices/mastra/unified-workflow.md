# 完整产研流程

2026-11-07 起，Studio业务主入口为 `productDevelopmentWorkflow`（内部 ID 为 `product-development`）；另注册六个具名开发独立评测Workflow，仅在隔离候选中考核单个角色。旧提案链、独立产品交接及修订入口从 Studio 移除；历史源文件与数据库保留，旧 CLI 仅作兼容。

启动 `npm run dev`，打开 `http://127.0.0.1:4111/workflows/productDevelopmentWorkflow/graph`。首次输入 `{ "iterationId": "recruitment-001", "brief": "你的需求" }`；迭代未指定时默认 `unassigned`。图中的 Workflow 可展开查看产品、开发、测试与部署子步骤。主链保持一个 Run，各角色在自己的子流程内扩展。

```text
原始需求
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
       业务缺口/无法自动处理 → 明确终态或人工裁决
  → testing：独立测试子流程
       prepare-test-plan：测试角色读取需求与实际源码
       approve-test-cases：确认用例、预期、需求与登记检查映射
       execute-tests：隔离环境重跑登记套件
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

产品、项目范围和方案在同一个原生 Run 中暂停与恢复。产品退回修改保存 `rework-requested` 终态，带反馈重新发起需求。开发模型故障保留失败任务和已合并的成功任务，提供一次人工接续；不承诺强杀或跨实例的原子恢复。

## 项目范围确认

在 `confirm-project-scope` 的 Resume 输入填写以下结构。`files` 是显式提供的初始源码，`writablePaths` 是精确写权限，`checkFiles` 必须存在且不可写。当前执行器支持受限 Node `.mjs` 语法检查及登记的 Node 检查，不支持任意项目命令。

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
  "maxReworks": 1
}
```

示例只说明格式，不是实际业务验收。业务代码的目标仓库已确定为 `leidaibo-lab/hrm`，但当前执行器仍写候选目录，尚未接通 Git 回库或整仓 pnpm 执行。输入、候选文件保存在当前数据目录的 `development-runs/<Run标识散列>/`。原生 LibSQLStore 保存流程事实；候选目录不创建第二套审批库。授权人是本地标签，当前未接入认证。

## 团队、委派与数据边界

成员由任务包动态生成，包含 `id/role/taskId/paths`，团队参与批准包散列。前后端任务无依赖且文件无冲突时可同时执行；有依赖则等待前序合并。每个成员读取同一波次快照，在独立临时候选目录工作，屏障后由宿主校验并合并成功补丁。

任务负责人通过原生工具 `delegateTask` 创建子 Agent，自主选择已登记角色、目标和父任务路径子集。最多3次、深度1；子任务路径须无重叠且覆盖父任务。父成员无直接写工具，子成员无继续委派工具。委派目标、角色、路径、父子 ID 和输出/源码散列持久化；父子调用共用72次预算。任意角色、宿主文件、命令或无限递归未开放。

Zod schema 约束跨模块数据，步骤返回新状态；补丁映射按文件定位，完成任务按 ID 管理。工厂模式创建动态 Agent，执行作用域适配器隔离每个 Run 的 I/O，原生 Workflow 负责调度和持久化。自有适配只负责依赖波次、授权及补丁合并，不另建通用引擎。

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

终态 `delivery-confirmed` 表示基于已收集证据确认交付，不表示远程机器独立验证；fixture 模式仅产生 `fixture-completed`。其他终态包括 `blocked/rework-exhausted/rejected/rolled-back/manual-attention`。产品审批前的拒绝/退回仍保留原产品状态结构。新图使用新 Run；旧 Run 不承诺跨版本透明续跑。

## 本轮验证

按用户要求未新增或运行测试，未发起真实模型业务 Run。仅完成 TypeScript 类型检查、运行中的 dev 编译及只读 API 图数据核对；API 只注册一个 Workflow，主链包含 testing、deployment 与最终交付。浏览器控制当前不可用，未进行图形界面交互验收。历史测试计数不证明本轮团队、缺陷修复或发布执行成功。真实模型、业务测试覆盖、远程发布/回滚与跨实例恢复未验收。

采用锁定版本的原生 Workflow 嵌套与 `foreach concurrency`，未采用 Agent network 自由路由或自建通用调度引擎；原因、维护责任、退出及重评条件见[决策记录](../../docs/decisions/2026-11-07-mastra-unified-development-team.md)。

测试与部署的选型、人工回执边界和重评条件见[完整产研生命周期决策](../../docs/decisions/2026-11-07-mastra-full-delivery-lifecycle.md)。

## HRM 资产落地与资料来源（2026-11-07）

Studio 使用同级 `/Users/lei/code/hrm` checkout，或由进程变量 `MASTRA_HRM_REPOSITORY` 指定绝对路径，origin 必须匹配用户指定仓库。四产品角色改为只读该仓库 `product/sources/`。旧 CLI 与配对评测仍沿用原资料条件；不会自动把历史量表/评审开放给 Agent。

| 产物 | HRM 本地归档 |
| --- | --- |
| 产品稿、四角色输出、审批、项目范围、方案/任务/研发交接元数据 | `product/runs/<runId>/<stage>/<hash>/` |
| 测试计划、用例、结果、缺陷与历史 | `testSet/runs/<runId>/<stage>/<hash>/` |
| 发布方案、范围、发布/健康/回滚回执、最终状态 | `deploy/runs/<runId>/<stage>/<hash>/` |

宿主在角色关口暂停前/返回后导出，manifest 最后落盘，同版本不覆盖。导出失败节点显式失败，不能绕过失败宣称已归档；尚需真实 Run 验收失败后补归档和恢复。文件是交付投影，审批与恢复继续以原生 Store 为准。Studio 另提供 `hrm-product/hrm-testset/hrm-deploy` 三个只读文件视图。

来源清单为 `hrm/product/sources/manifest.json`，目前复制原始 brief 并登记出处/散列，pm-hrm 仅登记参考尚未加载。当前用户确认和本 Run 批准需求决定范围。`sources-observed-at-export.json` 只是归档时来源清单，不能证明生成时工具实际读取；逐 Run 冻结及工具引用仍是待办。

本轮仅静态检查及只读 API 装配核对，没有运行测试/业务 Run/部署，也没有提交或推送 HRM。代码回库、全栈执行、CI/制品、历史 Run 补导出和恢复等剩余项见 `hrm/docs/delivery-assets.md` 与[资产决策](../../docs/decisions/2026-11-07-hrm-repository-assets.md)。

## 产物归档与查看（2026-11-07）

已将项目、迭代和根 Run 关联贯穿产品、开发、测试与发布；所有角色阶段的完成/暂停关口归档不可变文本投影。统一查看入口为 `http://127.0.0.1:4111/delivery-assets`，提供筛选、历史版本、纯文本预览、单文件和 JSON 包下载；原生 Studio 继续拥有审批和恢复。结构、接口、归档时机、实际限制与 SVG/PNG 数据流转图见[详细说明](./artifact-dataflow.md)。历史 Run 无关联时保留未关联状态，不自动归入本次迭代；本轮未运行测试或业务 Run。


## 2026-11-07 能力检测补充

新版可靠性回归已补齐，14项新增、全实践136/136通过，并修复QA报告因字段顺序规范化产生的假漂移。覆盖主链、跨Store暂停恢复、真实并行/依赖、成员失败隔离、委派越权、测试返工和发布/回滚门禁。真实模型业务切片独立记录，不能以回归计数宣称质量通过。命令、证据与边界见[能力检测记录](./evaluations/reliability/2026-11-07.md)。


架构诊断续验：v2故障/恢复载荷新增可选脱敏diagnostic，真实冻结输入定位`context-ref-unknown`。补充分组引用与字段规则后，同一输入架构复测通过；全实践139/139回归通过。此结果仅覆盖架构阶段，完整业务交付尚未通过，详见上述检测记录。


## Agent 资源归属核对

当前资源、生产消费关系、版本绑定及配置权威入口见[资源衔接清单](./config/workflow-resources.json)与[边界说明](./config/README.md)。清单是审计快照，尚未被运行时加载。当前运行事实基本归原生Store，Agent间最小输入契约和统一资源配置仍有缺口，不能宣称完全解耦。


资源接入的具体定义已形成：[配置/冻结/最小输入契约](./config/runtime-resource-contract.md)与[JSON示例](./config/workflow.runtime.example.json)。本轮仅定义新版本与迁移规则，当前Workflow仍按现有实现运行；不能把配置示例或审计清单当作已生效能力。


## 原生评测面板

产品角色、独立测试与部署方案已接入Mastra原生Datasets、Scorers和Experiments。运行`npm run eval:native:seed`导入，`npm run eval:native -- --run`追加实验；在Studio的Datasets/Experiments查看结果和对比。首批6组18例，动态开发节点尚未全部接入。用例版本、质量判定、live/fixture与验证边界见[原生节点评测](./evaluations/native/README.md)。


固定流程已补[独立评审与缺陷返工专项](./evaluations/native/review-rework/README.md)：三例真实评审/返工专项中两例通过，修复例因复评报告校验失败保持暂停，未放宽交付门。详见[实测记录](./evaluations/native/review-rework/observations-2026-11-07.md)。

六类开发上下文、架构、就绪、实现、自检、代码评审的独立原生数据集与执行目标已补齐，每类3例；用例、命令与验收边界见[开发独立节点评测](./evaluations/native/development-nodes/README.md)。业务审批、动态团队与发布路径不因此自动通过。
