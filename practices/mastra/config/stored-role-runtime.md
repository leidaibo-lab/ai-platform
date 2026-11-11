# 产研角色原生版本与 Run 恢复

Mastra Stored Agent 和 Skill 版本库拥有角色配置、正文及参考文件。应用只保存 Run 引用、验证完整性并注入当前任务的工具执行器。依据：[决策](../../../docs/decisions/2026-11-11-mastra-stored-role-runtime.md)、[稳定契约](../../../openspec/specs/mastra-role-resources/spec.md)。

## 执行链路与职责

`工作台创建 Run → freeze-role-resources → 需求澄清/四产品角色 → 开发团队 → 测试 → 发布回执/健康检查`。

首步在模型调用前将 `role-resources.v1` 写入原生 Workflow 输出。保存 Run ID、28 个角色变体的 Agent/version ID、配置摘要、工具契约摘要、端点身份和制品摘要；Skill pin 由固定 Agent 版本持有，不复制正文。产品、开发、测试、运维使用同一装配边界。

暂停后重新装配应用，步骤守卫从已提交首步读取引用，核验制品、端点、Agent 和 Skill blob，再通过 `MastraEditor.agent.getById(id, { versionId })` 解析。异步作用域只隔离当前执行段，不拥有第二份 Run 状态；动态开发工具闭包始终来自当前任务。

核心审批、候选文件范围、登记命令、输出解析和验收仍由现有 Workflow/执行器负责。增强只能选择宿主允许的工具，不能删除核心工具，也不能把 Skill 文本变成执行授权。当前通用增强工具为只读 `practiceInfo`；新增工具须在宿主登记并签入新制品，不开放任意网络插件或脚本加载。

## 初始化与发布增强

在 `practices/mastra` 使用 Node 24。这些命令使用本实践数据库，不改动业务 Run：

```sh
npm run resources -- init
npm run resources -- show role-productAgent
npm run resources -- publish-skill role-skill-my-method /absolute/path/to/my-method
npm run resources -- publish-agent role-productAgent /absolute/path/to/product-agent.json
```

`show` 输出可编辑配置。保留必需字段，在 `skills` 增加 `{"role-skill-my-method":{"pin":"发布命令返回的版本ID"}}`；可调整 `instructions`、`model.name`、`temperature`、`topP`、`maxCompletionTokens`。工具只引用该角色宿主登记能力；有 Skill 时须保留原生 inline Workspace。provider 当前限定为 `openai`，沿用服务端 OpenAI-compatible 端点。

`publish-skill` 通过原生发布器保存完整 blob/tree 并返回 pin；随后发布 Agent，才让新 Run 选择新版 Skill。单独切换 Skill 发布指针不会改变已有 Agent 的 pin。Agent 发布先校验配置与工具，再创建原生版本并校验所有内容引用，通过后才移动发布指针。

启动不会覆盖已有实体。`MASTRA_MODEL` 和角色模型环境变量仅决定首次导入的默认值；已有角色更换模型须发布 Agent 版本。旧 Run 继续使用原版本，新 Run 使用新发布版本。默认模型或凭据轮换不改变旧 Run 身份；端点变更拒绝恢复。

当前提供服务端 CLI，尚未新增工作台可视化角色编辑页面。未启用原生编辑器的任意远端工具、处理器和动态表达式配置。

## 可信制品

live 主流程必须配置独立部署路径：

```sh
MASTRA_ARTIFACT_MANIFEST=/absolute/path/to/role-artifact.json
MASTRA_ARTIFACT_PUBLIC_KEY=/absolute/path/to/trusted-ed25519-public.pem
```

在可信发布环境准备 Ed25519 私钥，安装依赖并构建后生成清单：

```sh
npm run resources -- sign /absolute/path/to/practices/mastra /secure/release-private.pem /release/role-artifact.json
```

公钥通过部署配置独立分发；私钥不进入应用配置、Run 或 Store。清单输出使用新文件路径，拒绝覆盖。签名后不能再修改依赖、源码或构建文件；运行端保留这些目录并使用只读制品。当前格式不是只携带打包入口的最小镜像格式。

清单覆盖 `src/`、`package.json`、`package-lock.json`、`node_modules/` 实际内容、存在时的 `.mastra/output/` 和 `config/material-policy.ts`，以及 Node 版本；不读取用户 `.env`、运行数据库或业务候选。执行树符号链接拒绝，包管理器 `.bin` 入口除外。工具 schema 与实现属于制品，工具契约摘要同时绑定制品摘要和固定工具配置，不只比较工具名或版本标签。

每个新执行段重新检查完整字节，有 I/O 成本。运行中代码与磁盘替换的竞态由只读部署控制，本机制不能防御被接管的宿主进程。部署升级后旧 Run 须由原可信制品执行；当前未实现自动多版本部署路由。

fixture 使用明确标识的无签名测试摘要，不能让 live 降级。独立 Agent/节点评测入口保持原用途；资源守卫覆盖正式产研主 Workflow，不将 Studio 独立聊天宣称为已冻结 Run。

## 恢复与保留

新内部 Workflow ID 为 `product-development-resources-v1`，工作台注册名仍为 `productDevelopmentWorkflow`。无冻结记录的历史 Run 不恢复、不补造兼容记录；旧数据库不删除。重新执行首步也不能覆盖已有引用。

Run 保留期间必须保留引用的 Agent/Skill 版本及 blob。版本、工具或 blob 缺失，签名失败、制品/端点漂移都拒绝；恢复原资源后再续跑，不能篡改 Run 引用强行通过。调用级 `model`、`instructions`、`tools` 不得覆盖冻结配置；`toolsets` 仅允许原有任务资料工厂生成的受限只读闭包，通过对象身份校验，不能用同名对象伪造。

模块职责：`native-store.ts` 原生版本解析/发布；`catalog.ts` 宿主角色契约；`assembly.ts` 按任务装配；`artifact.ts` 制品核验；`runtime.ts` 步骤守卫；`scope.ts` 异步隔离。使用适配器、工厂和步骤装饰器，现有 Workflow 保持业务状态所有权。

## 验证入口

```sh
npm run check
node --import tsx --test tests/role-resource-runtime.test.ts tests/unified-workflow.test.ts tests/guided-intake.test.ts tests/run-archive.test.ts
```

覆盖正式入口新旧版本分流、Skill 内容与模型参数、工具/版本/blob 缺失、端点变更、首步重放及增强前后完整主链。完整链使用合成模型、审批和发布回执；签名路径使用临时测试密钥和本地 HTTP 模型服务。真实模型业务质量、生产凭据及实际生产部署须另验。
