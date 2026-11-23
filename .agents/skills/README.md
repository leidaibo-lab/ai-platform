# Agent Skills Index

根 `.agents/skills/` 保存共用治理、研发、文档和测试 Skill；产品方法源位于 `nacos-resources/product/skills/`。两处均由同一治理脚本校验；团队运行方法以 Run 冻结的 Nacos 目录为准，源文件用于治理、候选导出和历史兼容。

## 目录规则

- Skill 使用 `.agents/skills/<顶级目录>/<技能目录>/SKILL.md` 两级结构。
- `SKILL.md` 的 frontmatter 包含 `name`、`description`、`metadata.pattern`、`metadata.author` 和 `metadata.version`。
- `name` 与 `<顶级目录>-<技能目录>` 一致，中文正文为主；详细资料放在 `references/`，模板放在 `templates/`。
- 引入上游内容时保留来源锁、许可与必要的原文；不要创建 `.cursor/`、`.trae/`、`.qoder/`、`.vscode/` 或根 `skills/` 平行目录。

## 主要入口

| 范围 | 入口 | 用途 |
| --- | --- | --- |
| 公司公共治理 | `company-public/skill-governance/SKILL.md` | 新增、迁移和校验 Skill |
| 产品需求交接 | [`product/requirements-handoff/SKILL.md`](../../nacos-resources/product/skills/product/requirements-handoff/SKILL.md) | 将真实业务诉求整理为可验收交接稿，统一文档版式及产品任务的结果、验收和需求引用 |
| 产品需求对齐 | [`product-pm/product-requirements-alignment/SKILL.md`](../../nacos-resources/product/skills/product-pm/product-requirements-alignment/SKILL.md) | 公司正式需求写作与复核方法，由 Nacos 产品经理和审查角色绑定 |
| 开发架构文档 | `development/architecture-document` | 开工送审正文、影响范围、架构与数据流图 |
| Mastra 框架开发 | `development/mastra-framework/SKILL.md` | 开发与排障时按安装版本核实 Mastra 原生能力和 API |
| 开发交接与 BMAD | `development/` | 需求到实现提案、上下文、就绪和只读评审 |
| gstack 工程方法 | `development/gstack-engineering-review`、`development/gstack-code-review` | 方案、实施前风险和只读代码审查；保留宿主权限边界 |
| 文档决策 | `docs/architecture-decision/SKILL.md` | 架构与方案决策记录 |
| 工作台 UI 设计 | `workbench/ui-design/SKILL.md` | 工作台页面设计、组件复用、交互及可访问性 |
| 浏览器测试 | `testing/gstack-browser-qa/SKILL.md` | 浏览器 QA 证据 |
| 产品专项方法 | [产品资源清单](../../nacos-resources/product/manifest.json) | PRD、用户故事拆分、验收场景和关键业务分支审查 |
| 产品方法归档 | [上游方法索引](../../nacos-resources/product/skills/product-pm-catalog.md) | 111 项上游方法与流程来源 |

PM 套件的来源锁与 MIT 声明位于产品资源 Skill 根的 `upstream-lock.json` 和 `licenses/`。应用接线与限制见 [`docs/application/browser-qa.md`](../../docs/application/browser-qa.md) 和根 `AGENTS.md`。

## 校验

```bash
node .agents/skills/company-public/skill-governance/scripts/validate-skills.mjs
```

修改 Skill 的名称、路径或触发说明时，同步更新根 `AGENTS.md`、本索引和涉及的 OpenSpec。
