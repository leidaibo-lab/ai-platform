# C1 ChainTrace 运维说明

本文保留 C1 ChainTrace 后续正式后端的本地和单团队初始部署路径。正式选择是 Phoenix 19.10.0 + PostgreSQL 17；Runtime 保持后端中立，只通过 OTLP/HTTP protobuf 旁路导出脱敏 Span。生产 TLS、高可用、容量规划和企业身份源不在当前切片内。

## 当前状态

ChainTrace 技术接入、后端选型和部署入口已经保留，但 `OTEL_ENABLED` 继续默认 `false`。正式 Phoenix 实例、真实 Runtime JSON/SSE Trace、三业务 ID 查询、隐私复核、故障隔离和四维运行态基线当前为 TODO，日常项目启动不要求执行本文步骤。

当出现难以通过 Run 状态和日志定位的问题、需要阶段 P50/P95/重试/Token 基线、进入多人共享或准生产部署、运行节点增多，或者维护者决定完成运行态验收时，再按本文启用。阶段决策与完整触发条件见 [C1 ChainTrace 运行态验收延期](./decisions/2026-07-30-c1-chaintrace-runtime-validation-deferral.md)。

## 数据与安全边界

- Conversation、Run、Message 和 Memory 的事实源仍是 Runtime SQLite；Phoenix 只保存可观测证据。
- Phoenix PostgreSQL 使用独立数据所有权，不与 Runtime、LiteLLM 或业务数据库共享。
- `recordInputs=false`、`recordOutputs=false`；Prompt、回答、图片 URL、文档 URL、原始错误正文和 stack 不进入 Trace。
- Phoenix 开启 Auth、强密码策略和 30 天默认保留，关闭匿名 telemetry，并禁用全部代码沙箱 provider。
- `PHOENIX_SECRET`、管理员密码、PostgreSQL 密码和 system API key 只放服务端 `.env`，不得提交或发送到浏览器。

## 启动后端

在 `.env` 中设置以下值。PostgreSQL 密码会被 Compose 装入数据库连接 URL，应使用只包含字母、数字和 `._~-` 的长随机值，避免未编码的 URL 保留字符。

```bash
PHOENIX_POSTGRES_USER=phoenix
PHOENIX_POSTGRES_PASSWORD=替换为URL安全的长随机值
PHOENIX_POSTGRES_DB=phoenix
PHOENIX_HOST_PORT=6006
PHOENIX_SECRET=替换为至少32位且包含数字和小写字母的随机值
PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD=替换为符合强密码策略的首次密码
```

启动固定 Phoenix digest 和 PostgreSQL 17：

```bash
docker compose --env-file .env -f docker-compose.chaintrace.yml up -d
docker compose --env-file .env -f docker-compose.chaintrace.yml ps
```

`PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD` 只在首次创建默认管理员时读取。首次登录使用 `admin@localhost`，登录后立即修改密码。

Phoenix 默认只绑定宿主机 `127.0.0.1:6006`。如果该端口已被 PoC 或其他服务占用，先把 `PHOENIX_HOST_PORT` 改为未占用端口，并同步修改 Runtime 的 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`；生产对外入口应由独立 TLS 反向代理和网络策略负责。

## 创建导出凭据

开启 Auth 后，匿名 Trace 写入和查询都会被拒绝。管理员在 Phoenix Settings 创建 system API key，再把它配置为 Runtime 的标准 OTel header：

```bash
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:6006/v1/traces
OTEL_EXPORTER_OTLP_TRACES_HEADERS=authorization=Bearer%20你的system-api-key
OTEL_EXPORTER_OTLP_TRACES_TIMEOUT=10000
OTEL_SERVICE_NAME=ai-platform-demo
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=1
```

`%20` 是 `Bearer` 与 key 之间空格的 OTel header 编码。`OTEL_EXPORTER_OTLP_TRACES_HEADERS` 覆盖同名的通用 `OTEL_EXPORTER_OTLP_HEADERS`；任何凭据都不得写入 README、决策记录、Trace 属性或测试输出。

## 健康与验收

先验证服务健康，再确认 Auth 拒绝匿名业务 API：

```bash
curl --fail http://localhost:6006/healthz
curl --output /dev/null --write-out '%{http_code}\n' http://localhost:6006/v1/projects
```

第二条命令应返回 `401`。然后重启 Demo Server、执行一个 JSON 或 SSE Run，并完成以下检查：

1. Phoenix 收到 `c1.conversation.run` 根节点以及排队、Run 落库、Context Planner、模型、完成落库和渠道交付 Span。
2. `ai.platform.request_id`、`ai.platform.conversation_id` 和 `ai.platform.run_id` 可组合精确定位同一 Trace。
3. 模型重试留在同一 OTel `trace_id`；幂等重放产生新 Trace、复用业务 Chain ID 且不再次调用模型。
4. Span 扫描不包含 Prompt、回答、图片、文档 URL、原始错误和任何凭据。
5. 停止 Phoenix 后，业务 Run 仍按自身规则成功、失败或取消，不因 exporter 失败重试模型或重复交付。

本地回归命令：

```bash
npm run test:telemetry
openspec validate --specs --strict
```

## 备份、升级与回滚

每次升级前必须对 PostgreSQL 执行 custom format 备份并记录 SHA-256，同时记录当前 Phoenix 和 PostgreSQL 镜像标识。备份文件不得放入 Git 仓库。

升级验收顺序固定为：

1. 在旧版本写入一条可按三个业务 ID 查询的脱敏 Trace。
2. 停止 Phoenix 写入，完成 PostgreSQL 备份和校验值记录。
3. 只更新经过决策接受的不可变 Phoenix digest，等待数据库迁移和健康检查完成。
4. 查询升级前 Trace，再写入并查询一条升级后 Trace。
5. 回滚时恢复升级前数据库备份并启动旧镜像，不能只回退应用镜像。
6. 确认旧 Trace 恢复、升级后新增 Trace 不存在、匿名查询仍为 `401`。

19.9.0 到 19.10.0 的升级、备份恢复和回滚证据见 [C1 ChainTrace 最终后端采用 Phoenix](./decisions/2026-07-30-c1-chaintrace-backend-phoenix.md)。出现多组织/项目级隔离、SAML/JIT、保留合规变化或单应用 + PostgreSQL 容量不足时，应先重评后端决策，不直接扩大当前实例边界。
