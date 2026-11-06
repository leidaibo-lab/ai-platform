# Ticket真实技术栈研发试点

这是独立、单案例PoC，不属于24例函数切片统计，也不启动测试Agent。设计、候选与边界见[决策](./decision.md)，固定需求见[input.json](./input.json)。

`project/`是主持维护的框架装配和明确未实现的三个目标文件；`reference/`是主持参考实现，专门验证容器与检查。真实模型模式不读取或复制reference，使用既有Mastra `generateDevelopment`架构/前端/后端角色实际读写三个白名单TS文件；组织者随后执行固定容器检查。模型没有Docker命令、网络和真实数据库凭据。

在Mastra实践根，使用Node24与已运行的Colima：

```bash
node --import tsx scripts/development-stack-eval.ts --source reference
node --import tsx scripts/development-stack-eval.ts --source agent --live
```

每次新建 `.data/evaluations/development-stack-*`；包含初始装配hash、模型角色/原生工具事实、实际命令/退出码/原始日志、代码hash、API断言、重启持久化与清理结果。独立package/lock位于project，不修改Mastra依赖。

默认仅验证API编译、Next生产构建、真实Prisma迁移、创建/列表/非法输入、Next HTTP与API代理、API/数据库重启持久化。没有实际浏览器交互则明确`not-executed`，不能从HTTP响应推断表单可用或可访问性通过。人工分数与能力准入保持null。主持基准通过只证明环境，不冒充Agent通过；Agent单次通过也不是整个技术栈或研发流程准入。

Compose运行网络为internal，只使用合成数据库且没有宿主挂载；Docker构建需要公共依赖下载。退出清理本次项目容器、网络、卷与镜像。脚本始终显式`--context colima`，不切换全局context、不停止Colima。

## 2026-11-06 主持基准实测

命令：`node --import tsx scripts/development-stack-eval.ts --source reference --out .data/evaluations/development-stack-reference-2026-11-06-v4`，使用明确Node24.19.0可执行路径运行。报告位于 `.data/evaluations/development-stack-reference-2026-11-06-v4/report.json`；同目录保留manifest、commands、源码hash、build/migration/http-smoke/persistence原始日志。

固定栈实际为Next16.4.5、React19.3.1、Nest12.4.0、Prisma/client/adapter-pg7.10.1、pg8.23.1、Node24.19.0，PostgreSQL运行日志为17.11，Linux ARM64。Node镜像digest为`sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df`，Postgres为`sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994`。候选源码树hash为`575f6e5090d65f774ae1ee21e824093b25d867c502569cc91a798e5a6ab8122f`。

主持参考实现的候选禁网生产构建、Nest TS编译、真实迁移、POST201与trim/120长度边界、8类非法输入400且不写入、GET稳定排序、Next HTTP200、同源API代理、数据库/API/web重启后原2条记录UUID持久化均通过；`cleanup=true`。未执行浏览器表单交互、可访问性、人评、隐藏验收或真实Agent实现。所有这些结果均属于`host-reference`，能力准入与人评分数保持null。

历史失败不覆盖：首轮DockerHub token TLS超时；v2构建成功后因数据库镜像尚未就绪而inspect失败；v3真实迁移成功但Docker29内部网络宿主端口映射无效。v4改为固定内部容器HTTP检查并完整通过。各轮日志与失败报告均保留。Prisma曾提示OpenSSL探测警告，本轮迁移仍成功，不据此承诺其它镜像兼容。

## 后续TODO

- [ ] 在开发恢复缺口修复及v3完整复测后，与主评测错开的窗口显式运行 `--source agent --live`，新建`development-stack-agent-v1-*`目录；不复用或回写reference结果。
- [ ] 记录真实架构/前后端角色调用、三个TS文件差异、工具事实、代码hash和固定容器检查；失败保留，不用主持参考实现替换。
- [ ] 单独补真实浏览器表单、加载/错误/空状态与可访问性验证；未运行前继续保持`not-executed`。
- [ ] 由独立负责人审阅Agent产物；单案例不能给出整栈或完整研发Workflow准入结论。
- [ ] 如扩大到迁移设计、鉴权、并发或部署，先新建需求与隔离/评测决策；当前主持schema/迁移/装配不能计为模型能力。

按用户要求此处收尾，未启动Agent live。临时容器/卷/网络/候选镜像已清理；主Agent已将Docker context恢复为default并停止本轮启动的Colima。后续运行需显式启动Colima；依赖镜像缓存保留以便接续。
