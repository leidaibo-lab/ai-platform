# Stored Agent 角色资源完整验证（2026-11-11）

四项验证已执行。结论是采用 Mastra 原生 Stored Agent、Skill pin 和 Workflow 持久化；应用补齐 Run 资源引用、恢复装配和可信制品核验，不自研 Agent/Skill 版本库或编排引擎。这里是隔离实验通过，不表示正式工作台已完成迁移。

## 版本与执行依据

- 仓库基点：`042b7d5628c894ad34f42f18ca846c7edd95df5d`，在有既存未提交修改的工作区执行；不是干净提交的生产发布验收。
- Node `24.19.0`、项目 `@mastra/core 1.81.0`、`@mastra/libsql 1.28.0`、`zod 4.4.3`；隔离安装 `@mastra/editor 0.17.0`，其 core/libsql 固定为相同版本。
- API 以这些实际安装包的声明与源码为依据，包括 `StorageAgentSnapshotType`、Editor `getById`/`resolveStoredWorkspace`/`resolveAgentSkillSource` 和 Workflow `loadWorkflowSnapshot`。
- 正式代码、依赖清单和 lockfile没有因本实验改变；新增验证代码位于 `tests/*.probe.ts`，不自动混入常规 `npm test`。
- 一次完整运行：12项测试通过，0失败、0跳过；`npm run check`、`openspec validate --specs --strict`（1项）和`git diff --check`通过。预期拒绝测试会打印原生错误日志，以退出码和断言结果判断通过。

## 完整结果表

| 验证 | 实际实验与判定 | 结果 | 可采用边界 |
| --- | --- | --- | --- |
| 真实产品、开发角色 Stored Agent 纵切 | 从现有产品写作、开发上下文、后端实现工厂导入真实职责与工具；原生模型循环执行 Skill、参考文件读取、候选文件读写 | 通过，3个独立角色用例 | 角色职责可存为模板，运行内 ExecutionPort/委派回调仍由宿主按当前任务注入 |
| 可信制品漂移拒绝 | 固定宿主公钥验 Ed25519 签名，再比较 Run 摘要、角色源码摘要、依赖锁；未变制品执行，代码/配置变化、新的合法签名版本替换、非可信签名、角色源码变化、依赖锁变化均拒绝 | 通过，1个正例、6个拒绝例；拒绝时工具调用次数为0 | 应用负责信任根与核验；本实验信任根为临时测试密钥，不代表生产 CI 签名或容器认证已接通 |
| 增强配置贯穿暂停恢复 | 同一 Skill 实体发布v2正文和参考文件；Agent发布v2模型配置；关闭Store并重新装配；旧Run从输入记录读取Agent版本，后续Run使用v2；缺失旧工具拒绝 | 通过，包含在3个角色纵切和完整主链中 | Run必须保存并传回Agent版本；Skill pin必须导入完整blob/tree；不能用最新发布指针恢复旧Run |
| 增强前后完整主链对照 | 原生`createProductDevelopmentWorkflow`全程执行；增强组4个产品角色及动态开发角色从Stored Agent装配；每次暂停重建Store/应用；第一次暂停后替换所有角色的已发布版本 | 通过，两组均`fixture-completed`、独立质量检查`passed`；各8个暂停点；增强组13次Stored角色执行 | 验证装配与业务控制流，不评价真实模型质量；审批、外部部署回执、健康回执为合成数据 |

另有1个必要负对照：固定Agent版本保留旧工具说明，但宿主把同一注册键替换成新实现后，原生Agent确实执行了新实现。该用例通过意味着已证实框架的冻结边界，而非工具代码已经由Mastra自动冻结。

## 完整主链实测

两组暂停序列相同：

1. `review-product`
2. `confirm-project-scope`
3. `approve-architecture`
4. `approve-test-cases`
5. `review-test-results`
6. `approve-release-scope`
7. `execute-release-externally`
8. `verify-release-health`

两组均真实执行前后端候选写入、2次子成员委派、登记检查与独立测试。终态候选源码摘要均为：

```text
c2c40c556ee322312d2fbbfae8462713c78209499b8ad7146021da2d1b5ee05a
```

增强组实际调用 `enhancement-v1`，产品组额外加载真实 `product-requirements-handoff`；开发方法角色实际调用 `skill`、`skill_read`。产品纵切只选择这一项受治理方法，不声称已将113项产品库存全部迁入Stored Skills。

完整主链外包一层实验原生Workflow，输入只增加资源版本引用；既有生产Workflow及其schema不改动。每次恢复从该Run数据库快照的输入取出版本映射，再按版本装配，清空上次内存映射，避免仅凭闭包“看起来能恢复”。原生业务Workflow仍负责门禁、团队和业务状态。此实验是跨Store重装，不是多机器、操作系统进程崩溃或并发抢占验收。

固定模型在调用参数中显式覆盖Stored模型，用于可重复驱动真实工具。没有调用远端模型，也没有伪称 `probe-model-v1/v2` 是可用的线上模型。

## 资源固定到什么程度

| 资源 | 已实测固定 | 仍需应用约束 |
| --- | --- | --- |
| Agent | instructions、工具引用/说明、Skill引用、模型配置随版本保存并按versionId解析 | 新Run创建时选择发布版本，旧Run恢复必须提供保存的版本；缺失版本不得降级到最新 |
| Skill | 同一实体发布新版本后，旧pin仍读旧正文；`skill_read`读旧参考文件，后续v2读取新参考标记 | 上传正文和references对应的blob/tree；保留被Run引用的版本和blob；仅写instructions字段不能替代完整内容树 |
| 工具 | 旧Agent的工具描述覆盖宿主新描述；版本化注册键可选择旧实现；缺失引用显式拒绝 | Mastra不序列化execute闭包；同名替换会运行新代码。实现、配置、依赖与部署制品需可信绑定；动态ExecutionPort须绑定当前Run/任务，不能冻结另一个Run的文件路径 |
| 模型 | provider/name、temperature、topP、maxCompletionTokens存入版本；实测旧temperature=0.2/maxOutputTokens=321，新版0.9/654 | 凭据、路由、上游模型权重和供应商服务不在此快照；调用级model/modelSettings可覆盖默认配置，正式装配需约束覆盖入口 |
| Workflow | 输入资源映射与暂停状态持久化，重建后能续办原任务 | 不自动快照宿主Workflow代码，也不自动把角色资源引用填入Run |

签名实验执行的是已核验字节生成的自包含工具模块，避免验签后再按可变路径import另一份代码。宿主角色文件/依赖锁漂移使用真实项目文件的隔离副本注入。该方法证明拒绝机制；生产落地应核验完整不可变构建制品，不能把几个源码文件或lockfile摘要当作已安装全部依赖、运行环境、CI来源的完整证明。

## 失败定位与重跑

- 首轮工具证据断言错误：原始多行Skill正文不能直接与JSON序列化上下文比较；改为相同转义形式，保留完整正文一致性检查。
- 完整链模板初始化缺少fixture所需source字段：补齐仅供构造模板的输入，真实运行仍使用Workflow当前状态。
- 无Skill的实现角色装配空Workspace触发`NO_PROVIDERS`：仅有Skill内容树时装配Workspace，不为无Skill角色制造空Workspace。
- 类型检查发现Workspace判别值被拓宽：改成`'inline' as const`，未用类型忽略绕过。
- 修正后整体重跑四项，而非只保留单项通过结果。

## 可重跑入口

在 `practices/mastra` 下使用Node24；不读取`.env`，不需要线上凭据：

```sh
probe_root=$(mktemp -d)
npm install --prefix "$probe_root" --save-exact --ignore-scripts \
  @mastra/editor@0.17.0 @mastra/core@1.81.0 @mastra/libsql@1.28.0 zod@4.4.3
MASTRA_EDITOR_PROBE_ROOT="$probe_root" node --import tsx --test \
  tests/stored-role-validation.probe.ts \
  tests/trusted-artifact-validation.probe.ts \
  tests/full-chain-enhancement.probe.ts
npm run check
```

- [角色纵切与工具负对照](../../tests/stored-role-validation.probe.ts)
- [签名制品及6类漂移注入](../../tests/trusted-artifact-validation.probe.ts)
- [完整主链对照](../../tests/full-chain-enhancement.probe.ts)
- [实验导入/装配辅助](../../tests/stored-role-probe-helpers.ts)

## 目标改造落点

不再重复验证原生版本能力。进入正式改造时，按现有[资源接入契约](../../config/runtime-resource-contract.md)更新决策和稳定契约，再落以下单一职责模块；历史Run兼容明确排除。

1. **资源发布**：原生Agent/Skill Store保存版本，现有治理资产导入blob/tree，发布角色可用配置。
2. **Run资源清单**：创建新Run时保存角色Agent版本、工具实现/配置和可信制品摘要；恢复读取同一清单。
3. **角色装配**：按清单解析Stored Agent，加载Skill pin，校验引用完整性，注入当前任务ExecutionPort；产品/开发只保留角色职责和已登记能力。
4. **制品核验**：可信公钥或CI制品认证归宿主配置，验来源、摘要和实现可用性，失败在模型/工具执行前结束；部署方负责不可变制品与旧版本保留。
5. **用户增强入口**：用户选择已登记Skill、工具、模型形成新配置版本；只影响后续Run。暂停Run不因用户修改发布版本而换资源。
6. **回归准入**：将本实验的资源发布切换、缺失引用、漂移拒绝、完整链对照迁到正式新Run入口；真实模型质量和真实部署单独验收。

设计使用导入Adapter和装配工厂，不新增调度器或版本存储。核心数据分为可序列化版本引用、原生资源内容、运行内工具闭包、独立信任根四类，所有权分开；实验辅助代码不直接成为生产公共层。正式模块维护归产研应用装配方，原生版本解析继续交给Mastra。升级core/editor、改变Skill布局、宿主部署方式或模型路由时重跑该矩阵。
