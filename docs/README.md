# 项目文档

这个目录承接项目结构、架构说明和运维边界。`AGENTS.md` 只保留 AI 协作入口和路由，详细说明放在这里。

## 文档索引

- [AI 结构说明](./ai-structure.md)：项目重新定义、五个父级能力、当前 LiteLLM/Demo Runtime 切片、配置和密钥边界，以及规划图和 V0.5-V4 实施对比。
- [编码规范](./coding-standards.md)：函数注释、数据结构、设计模式、设计原则和变更检查要求。
- [Agent Skills 索引](../.agents/skills/README.md)：本项目 Skill 目录规范、索引和治理要求。

## 与 OpenSpec 的分工

- `docs/` 解释项目如何工作、为什么这样分层、后续怎么演进。
- `.agents/skills/` 承接可复用的 Agent Skill、目录规范和治理口径。
- `openspec/` 固化稳定能力契约，约束后续代码和配置变更。
- `README.md` 保持用户启动和测试路径清晰，不承载过多内部协作细节。
