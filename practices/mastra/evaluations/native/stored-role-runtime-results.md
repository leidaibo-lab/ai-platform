# 正式产研入口资源验证记录

日期：2026-11-11。版本：core 1.81.0、editor 0.17.0、libsql 1.28.0；Node 24.19.0。

本记录对应正式 `product-development-resources-v1`，不重复计入[前置隔离实验](./stored-role-validation.md)。

| 验证 | 结果与证据 |
| --- | --- |
| 动态增强与新旧版本分流 | 暂停后发布Agent/Skill新版，旧Run重装后仍读取旧指令和正文，新Run读取新正文及temperature参数 |
| 完整链基线/增强对照 | 两条正式主链均完成；增强链八次暂停重装、暂停期间再发布版本，绑定不变，候选代码摘要与基线相同 |
| 模型传输 | 默认模型及凭据轮换不覆盖旧版本；端点变化拒绝；调用级model覆盖拒绝 |
| 内容完整性 | 指定Agent版本缺失、Skill版本缺失、blob缺失拒绝，不选择最新版本兜底 |
| 工具边界 | 未登记工具在首步拒绝；同名伪造资料toolsets拒绝；Workspace非只读工具配置拒绝 |
| 制品可信性 | 临时Ed25519签名通过；代码、依赖字节、额外文件、错误公钥、live无签名均拒绝 |
| 原生恢复 | HTTP澄清、产品写作Time travel、开发故障续办、返工及归档回归通过；两个并行资源作用域读取各自版本 |
| 历史Run | 无冻结记录拒绝，不执行补冻兼容；重复冻结读取原绑定 |

执行记录：

- 六文件主回归：`role-resource-runtime`、`unified-workflow`、`guided-intake`、`run-archive`、`blocker-clarification`、`development-state-flow`：50/50通过。
- 补充回归：`role-resource-runtime`、`development-recovery`、`development-recovery-review`、`intake-transport`：22/22通过；与前组有3项重叠，不累计为72项独立用例。
- 最终资源定向回归：3/3通过，补充并行隔离、缺失Skill和Workspace写能力拒绝断言。
- `npm run check`通过；`openspec validate --specs --strict`：2/2通过；`git diff --check`通过。

主链使用fixture模型和合成审批/部署回执。live路径使用本地HTTP合成模型与临时签名密钥，验证真实装配、结构化失败和HTTP 408后恢复，不代表真实供应商质量或生产部署验收。签名时完整扫描本机执行树约3.4秒（27594文件的一次观察，非性能SLA）；生产需只读制品、独立可信公钥以及旧Run制品保留策略。

操作、数据归属、自研边界与未实施部分见[配置与恢复说明](../../config/stored-role-runtime.md)。未实施可视化角色编辑、自动多版本部署路由、统一预算配置、最小交接DTO和业务资料快照。
