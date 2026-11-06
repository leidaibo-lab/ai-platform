# 为 Ticket 垂直切片采用独立全栈容器试点

- 日期：2026-11-06
- 状态：有界 PoC；用户授权建设研发阶段并复测，不代表生产采用或能力准入
- 结论：适配成熟框架；不修改现有 DevelopmentExecution 的命令、网络或写权限
- 维护者：Mastra 实践维护者

## 问题、候选与范围

现有24例是离线函数切片，不能证明真实前后端、ORM与数据库能够一起运行。此试点只验证一个 Ticket 创建/列表纵向切片，并区分主持基准与真实模型产出。

| 路线 | 取舍 |
| --- | --- |
| Next 单应用与 Server Actions + Prisma | 模块更少，但不能观察单独 Nest API 与前端契约，因此本轮未采用 |
| Next/React/TS + Nest + Prisma + PostgreSQL | 按用户技术方向组合原生框架，真实迁移和重启持久化；本轮采用 |
| 自写 HTTP/SQL/页面框架 | 无助于验证目标技术栈，维护成本更高，未采用 |

只读 npm 官方 registry 实际确认 Next 16.4.5、React 19.3.1、Nest 12.4.0、Prisma及adapter-pg 7.10.1；以 `project/package-lock.json` 为精确解析结果。Node24容器、PostgreSQL17镜像的实际digest写入每次运行manifest，不声称浮动标签不可变。Prisma7使用独立 `prisma7.config.ts` 与生成客户端、pg driver adapter。

## 固定输入与职责

公开需求见 `input.json`。主持拥有框架装配、数据库连接、schema/迁移、依赖锁、Dockerfile、Compose和固定检查。真实模型仅能写 `api/tickets.controller.ts`、`api/tickets.service.ts`、`app/page.tsx`；架构师只读，前后端通过既有原生Mastra `generateDevelopment` 工具实际读写。模型没有Docker、shell、网络或数据库工具。主持基准位于 `reference/`，不会复制给Agent模式。

架构采用显式 `evaluation-policy` 组织者确认，仅为执行PoC，不伪造人工批准。此独立pilot直接调用原生角色，不冒称完整现有开发Workflow、返工和人工方案审批均已验收。

## 执行、安全与检查

使用明确的 `docker --context colima`；容器不挂载宿主源码、凭据、Docker socket。候选仅作为构建上下文，依赖安装使用固定lock；下载依赖后的生成/API/Next候选构建使用BuildKit `--network=none`。运行时网络为本试点internal network，仅有临时合成PostgreSQL，不发布宿主端口；固定smoke在web容器内经内部DNS访问API。资源限额、只读根文件系统和tmpfs均由固定Compose设置。公共镜像/npm下载需要网络，候选构建及运行不能访问外网。

检查覆盖TypeScript编译、Next生产构建、真实迁移部署、API create/list、非法输入、API及数据库重启后的同一数据持久化、Next HTTP页面响应。浏览器交互如未运行则单独记为未执行。每次保存代码hash、实际命令/退出码/日志与来源。运行结束只删除本次project容器、internal network和临时卷；保留Colima VM及全局Docker context，恢复由根Agent统筹。

## 限制、退出与重评

单案例、单轮、公开检查，无独立人工分数和隐藏业务验收；无认证/租户隔离、并发、SQL迁移回滚、性能、安全攻防、队列、生产部署。容器不是恶意代码强隔离服务。主持参考实现通过不计入Agent能力成绩；真实模型改动即使通过也只证明本切片。新增生产数据、联网依赖、真实账号或更复杂案例时重新评估隔离与验收。删除本目录与专用脚本即可退出，不影响探索主线稳定契约。

## 官方依据

- Next安装：https://nextjs.org/docs/app/getting-started/installation
- Nest控制器：https://docs.nestjs.com/controllers
- Prisma7迁移：https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7

## 执行状态

执行结果写入各次 `.data/evaluations/development-stack-*` 的manifest、report与原始日志。2026-11-06 主持基准v4已完整通过禁网构建、真实迁移、API公开检查、Next HTTP/代理和重启持久化，详见[实测与待办](./README.md#2026-11-06-主持基准实测)。该证据只属于host-reference；真实模型产出、浏览器交互、人评与能力准入均未完成。

用户要求剩余工作转TODO后续继续，因此停止扩展且不启动live。后续agent-v1只实现三个白名单TS文件，独立目录登记来源，继续固定外部容器检查；不将主持schema、迁移、环境装配计为Agent完成。Colima与全局context由主Agent统一恢复，不由此试点停止VM。
