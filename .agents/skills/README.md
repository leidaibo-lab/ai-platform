# Agent Skills Index

本目录是探索主线与共用 Skill 的资产源；用户明确指定的 Mastra 产品套件仅放在 `practices/mastra/.agents/skills/`，由本索引登记并沿用相同治理。各作用域内的新增、更新、删除收敛在相应 `.agents/skills/` 下，不再创建 `.cursor/`、`.trae/`、`.qoder/`、`.vscode/` 或根目录 `skills/` 平行目录。

规范源参考：https://gitlab.seakoi.net/seakoi/skills

如本地说明与外部 `seakoi/skills` 仓库的当前指南、要求、原则冲突，以外部仓库为准。

## 目录原则

- Skill 目录采用两级结构：`.agents/skills/<顶级目录>/<技能目录>/`。
- 每个 Skill 必须包含入口文件：`SKILL.md`。
- `SKILL.md` 的 frontmatter 必须包含 `name`、`description`、`metadata.pattern`、`metadata.author`、`metadata.version`。
- `name` 必须等于 `<顶级目录>-<技能目录>`。
- `metadata.pattern` 必须说明 Skill 的主设计模式，建议值为 `tool-wrapper`、`generator`、`reviewer`、`inversion`、`pipeline`。
- `metadata.author` 必须说明维护负责人，可填写 GitLab 用户名、团队名或岗位角色。
- `metadata.version` 必须说明 Skill 自身维护版本，建议从 `1.0.0` 开始。
- 正文以中文为主，保留必要英文术语可以，但不要让英文成为主体。
- `SKILL.md` 保持精简，详细资料放 `references/`，模板放 `templates/`，静态素材或可复用附件放 `assets/`。

## 当前 Skills

### 公司公共类

| Skill | 入口 | 适用场景 |
| --- | --- | --- |
| company-public-skill-governance | `company-public/skill-governance/SKILL.md` | Skill 创建、更新、迁移、目录治理、结构校验和项目文档归属校验 |

### 产品类

| Skill | 入口 | 适用场景 |
| --- | --- | --- |
| product-requirements-handoff | `product/requirements-handoff/SKILL.md` | Mastra 产品 Agent 将真实业务需求整理为有范围、规则、验收条件和明确未决项的交接稿 |

### 开发类

| Skill | 入口 | 适用场景 |
| --- | --- | --- |
| development-implementation-handoff | `development/implementation-handoff/SKILL.md` | Mastra 开发 Agent 将已确认需求映射为实现方案、变更范围、验证计划和风险，不代表实际代码执行 |

### 文档与评测类

| Skill | 入口 | 适用场景 |
| --- | --- | --- |
| docs-context-memory-evaluation | `docs/context-memory-evaluation/SKILL.md` | 上下文记忆 fixture 设计、`outputSchema` 确定性链路、真实模型评测、指标对比和回归沉淀 |
| docs-architecture-decision | `docs/architecture-decision/SKILL.md` | 架构/方案决策的扫描、意图确认、Agent-first 起草、审查、生命周期和 OpenSpec 协作 |

## 更新要求

- 新增、移动、删除 Skill 时，同步更新本索引。
- 修改 Skill 的名称、路径、适用场景或触发描述时，同步更新根目录 `AGENTS.md` 的文档路由。
- Skill 内容不替代 OpenSpec；涉及代理行为、Demo API、鉴权、模型别名、上下文预算等稳定契约时，仍需同步 `openspec/`。
- 引用外部仓库内容时，只复制当前项目确实需要的 Skill 或参考材料，并在对应文件中注明来源；不要在本仓库保留外部 checkout。

## 校验

修改 Skill 后运行：

```bash
node .agents/skills/company-public/skill-governance/scripts/validate-skills.mjs
```

校验内容包括两级目录、`SKILL.md` 是否存在、`name` 与路径是否一致、`metadata.pattern` 是否为主设计模式、`metadata.author` 和 `metadata.version` 是否存在。

## Mastra 独立产品套件

用户指定的实践作用域：[完整索引](../../practices/mastra/.agents/skills/README.md)。资产唯一落点为 `practices/mastra/.agents/skills/product-pm/<技能>/SKILL.md`，name 为 `product-pm-<技能>`，沿用本规范与统一校验；这是根目录规则的显式例外。

套件固定 pm-skills 2.2.0 对应111个入口（69个方法、42个流程），另有1个本地导航。8个shipping迁移入口解析到已锁定的新仓方法；保留原文、MIT、逐文件SHA256和本地映射。产品角色加载套件及既有需求交接；技能方法不增加网络、任意文件/命令、部署或审批能力。
