# Agent Skills Index

根 `.agents/skills/` 是 AI 应用基础平台 v2.0 的唯一 Skill 治理入口。它同时容纳共用治理、研发、文档、测试与 Mastra 产品团队套件；旧 Mastra 实践目录不再持有独立 Skill 作用域。

## 目录规则

- Skill 使用 `.agents/skills/<顶级目录>/<技能目录>/SKILL.md` 两级结构。
- `SKILL.md` 的 frontmatter 包含 `name`、`description`、`metadata.pattern`、`metadata.author` 和 `metadata.version`。
- `name` 与 `<顶级目录>-<技能目录>` 一致，中文正文为主；详细资料放在 `references/`，模板放在 `templates/`。
- 引入上游内容时保留来源锁、许可与必要的原文；不要创建 `.cursor/`、`.trae/`、`.qoder/`、`.vscode/` 或根 `skills/` 平行目录。

## 主要入口

| 范围 | 入口 | 用途 |
| --- | --- | --- |
| 公司公共治理 | `company-public/skill-governance/SKILL.md` | 新增、迁移和校验 Skill |
| 产品需求交接 | `product/requirements-handoff/SKILL.md` | 将真实业务诉求整理为可验收交接稿 |
| 开发交接与 BMAD | `development/` | 需求到实现提案、上下文、就绪和只读评审 |
| 文档决策 | `docs/architecture-decision/SKILL.md` | 架构与方案决策记录 |
| 浏览器测试 | `testing/gstack-browser-qa/SKILL.md` | 浏览器 QA 证据 |
| 产品方法套件 | [`product-pm-catalog.md`](./product-pm-catalog.md) 与 `product-pm/<技能>/SKILL.md` | 111 项产品方法与流程入口 |

PM 套件的来源锁与 MIT 声明位于本目录的 `upstream-lock.json` 和 `licenses/`。应用接线与限制见 [`docs/application/browser-qa.md`](../../docs/application/browser-qa.md) 和根 `AGENTS.md`。

## 校验

```bash
node .agents/skills/company-public/skill-governance/scripts/validate-skills.mjs
```

修改 Skill 的名称、路径或触发说明时，同步更新根 `AGENTS.md`、本索引和涉及的 OpenSpec。
