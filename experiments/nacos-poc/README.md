# Nacos / Mastra 隔离 PoC

本目录验证 Mastra 依赖与资源恢复的基础假设，不接入主线，也不包含 Nacos 服务。使用 Node 24+：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
```

`mcp-client.mjs` 通过 stdio 连接固定只读 fixture，并以 Mastra 固定测试模型触发一次真实工具调用；`mcp-http.mjs` 使用本机随机端口验证 Streamable HTTP；`recovery.mjs` 在临时目录创建 LibSQLStore，使用两个独立 Node 进程模拟版本变化并恢复 Workflow，检验旧 Run 与新 Run 的资源内容。临时数据库路径由脚本输出，供检查；该脚本不自动删除。

2026-11-17 使用 Node 24.22.3、`@mastra/core` 1.81.0、`@mastra/libsql` 1.28.0、`@mastra/mcp` 1.18.0、`@modelcontextprotocol/sdk` 1.32.2 运行，三项通过；完整依赖由此目录的锁文件固定。固定模型不证明真实模型质量；同一进程内重建 Store 也不证明跨进程恢复或 Nacos 可用。

同日访问 Docker Hub 及镜像站拉取 `nacos/nacos-server:v3.3.0` 均出现 EOF；官方 GitHub 发布包下载在约 297 秒后超时，仅下载 14,899,273 / 233,718,638 字节。本次未启动 Nacos，故未验证真实 Prompt/Skill/MCP 生命周期、权限、撤销和资源下载。

同日网络切换后重新拉取成功，镜像摘要为 `sha256:bf18e41d09efd4e72edc46b010d42dca49f776421413cb2637be1fff0d6ef90f`。临时 standalone 实例成功启动并仅映射本地随机端口，未携带凭据查询 Prompt 返回 HTTP 403；尚未验证已认证的资源发布、读取及权限隔离。

### 真实 Nacos API 验证（2026-11-17）

在上述镜像的本地 standalone 实例开启默认鉴权，以测试管理员初始化并登录；运行 `nacos-api.mjs` 验证：

- 管理员创建 Prompt 后状态先为 `reviewing`，变为 `reviewed` 后显式发布，客户端按版本读取内容成功；下线后读取返回 404。
- 新建独立命名空间，同名同版本 Prompt 在两个空间各自读取到不同内容；另一个空间尚未创建同名资源时返回 404。
- 新建无授权用户，使用其有效登录 token 读取 Prompt、MCP 描述及 Skill ZIP 均返回 403；未认证 Prompt 请求也返回 403。
- 管理员通过 Client API 发布并查询固定 stdio MCP 描述。此步骤不执行描述中的命令，也没有验证远程 MCP 服务发现、端点鉴权或代理。
- 上传只包含合成 `SKILL.md` 的 ZIP，设置 `autoPublishIfNew=true`；最终状态为 `online`，客户端下载的 ZIP 版本头为 `1.0.0`，解压后的正文符合输入。测试未配置人工审批流程，不能视为人工批准证据。

脚本只接受 `127.0.0.1` 地址，运行时需设置 `NACOS_POC_URL` 和 `NACOS_POC_PASSWORD`。它会在该实例中创建测试用户、命名空间和资源，**仅用于隔离测试实例**，不会删除这些数据：

```sh
NACOS_POC_URL=http://127.0.0.1:端口 NACOS_POC_PASSWORD=测试密码 node nacos-api.mjs
```

后续补充验证：下载 ZIP 中的 `SKILL.md` 可由锁定版本的 Mastra `validateSkillContent` 和 `createSkill` 装配；两个独立 Node 进程可以基于同一 LibSQLStore 暂停和恢复合成资源快照。该恢复测试的资源来自合成数据，不是实际 Nacos，也没有覆盖产品主流程。

未覆盖具有精确授权的普通账号、权限撤销和缓存失效、MCP 远程端点、资源篡改、实际 Nacos 资源的跨进程恢复、完整主流程以及生产集群。上述证据不能证明这些行为。

曾在根项目临时执行 `npm install --no-save --package-lock=false @mastra/mcp@1.18.0`；npm 重新解析传递依赖后 `npm ls --all` 报告 `@mastra/deployer` / `@mastra/server` 的 peer 版本不兼容。此结果不说明正式锁定安装必然冲突，但说明不能直接将当次解析作为主线依赖方案。根目录随后已执行 `npm ci --ignore-scripts` 恢复锁文件安装；独立 PoC 的 `npm ls --all` 无 invalid 报告。正式接入前需锁定完整依赖并验证构建、测试和运行。
