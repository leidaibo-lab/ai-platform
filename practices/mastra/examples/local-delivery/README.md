# 本机工单交付闭环示例

用“工单标题校验页”验证现有 `productDevelopmentWorkflow` 的工程链路：需求 → 四产品角色 → 产品确认 → 项目授权 → 架构/就绪 → 批准 → 实际工具读写与委派 → 沙箱自检/独立评审 → 独立测试/浏览器 QA → 本机静态发布 → 健康检查 → 最终交付或回滚。

首版使用固定模型和预登记 `evaluation-policy` 自动提交示例决策。测试、Chromium、HTTP、制品摘要和回滚实际执行；不证明真实模型自主开发、人工业务验收、HRM 全栈或生产上线。现有 Workflow 发布 authority 仍是 `local-human-report`，机器观察单独保存在报告里。

本次正常发布与故障回滚均已执行通过，结果见[执行记录](./VALIDATION.md)。

## 运行

在 `practices/mastra` 下使用 Node.js 24+ 和已安装的实践依赖，不需要配置或加载 `.env`：

```bash
nvm use 24
npm run example:local-delivery
```

默认顺序执行两条路径，也可以单独运行：

```bash
npm run example:local-delivery -- success
npm run example:local-delivery -- health-failure
```

浏览器缺失时，按已有[浏览器 QA 安装说明](../../browser-qa.md)安装 Chromium；缺失、超时或断言失败都会使示例非零退出，不会跳过为通过。示例只启动临时回环服务，完成或失败后关闭，不影响工作台和用户服务。

## 验收什么

| 路径 | 必须观察到的事实 | 主 Workflow 终态 |
| --- | --- | --- |
| success | 工具实际修改占位源码；TYPE、空白、1/80/81码点、Unicode与trim检查通过；三个浏览器用例有截图；读取同版本候选构建真实页面；HTTP200、响应字节hash、发布页面交互通过；最后另作v0恢复演练 | fixture-completed |
| health-failure | 同样通过开发与独立QA；发布时实际注入HTTP503；主链进入回滚暂停点；切回v0后HTTP200、旧制品hash、页面文字均核验通过 | rolled-back |

每个人工暂停点都关闭 Store 并重装相同 Workflow，再用原 Run ID 恢复。自动确认仅限这个固定示例；未知暂停点、模型故障、质量失败或源码漂移都停止，不会自动批准缺陷或扩大权限。

工单业务输入为合成测试数据。页面仅静态 HTML，不访问数据库和外网；候选 `.mjs` 仅由既有 OS 沙箱执行，发布服务不执行候选 Node 代码。静态构建是从通过检查的候选读取并打包页面，不代表运行过前端编译器或容器部署。

## 看证据

命令最后输出 `.data/examples/local-delivery/<UTC时间>/<场景>/report.json` 的绝对路径。每次新建独立目录，不覆盖旧证据：

- `input.json`：需求、初始项目、检查与预登记决策身份。
- `workflow.db`：原生流程、暂停与审批事实。
- `gate-*.json`：各暂停点的载荷与实际提交决策。
- `workflow-result.json`：终态、开发交付、QA与发布回执；未正常结束时保存 `workflow-incomplete.json`。
- `artifact.json` / `page.html`：实际候选构建的制品，含源码hash与页面UTF-8字节SHA256。
- `report.json`：实际角色工具、进程检查、浏览器QA、发布HTTP观察、截图摘要与回滚结论。
- `baseline.png`、`published.png`、`rollback*.png`：实际浏览器截图；503没有成功页面截图。

`status: passed` 需要符合对应场景预期；故障场景的通过表示发现故障并成功回滚，不表示v1发布成功。`cleanup: true` 表示已清理本机服务。报告是观察投影，不能代替原生审批事实。生成数据已由实践 `.data/` 忽略，不提交运行库或大截图。

聚焦回归：

```bash
npx tsx --test tests/local-delivery.test.ts
npm run check
```

后续若要验证真实模型、真实业务或远程上线，应新增对应运行证据和环境授权，不能将本例的固定输出与自动决策作为其通过依据。方案与维护责任见[决策记录](../../../../docs/decisions/2026-11-09-mastra-local-delivery-example.md)。
