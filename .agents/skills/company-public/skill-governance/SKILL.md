---
name: "company-public-skill-governance"
description: "公司级 Skill 创建与治理规范。用于新增、更新、迁移或校验 .agents/skills 下的 Skill，确保目录、命名、frontmatter、中文正文、引用归属和 OpenSpec 边界符合 seakoi/skills 风格。"
metadata:
  pattern: "reviewer"
  author: "company-public"
  version: "1.0.0"
---

# Skill 治理规范

## 核心规则

- 所有 Skill 只放在 `.agents/skills/`。
- 目录采用两级结构：`<顶级目录>/<技能目录>/SKILL.md`。
- `name` 必须等于 `<顶级目录>-<技能目录>`。
- frontmatter 必须包含 `name`、`description`、`metadata.pattern`、`metadata.author`、`metadata.version`。
- `metadata.pattern` 必须说明 Skill 的主设计模式，建议值为 `tool-wrapper`、`generator`、`reviewer`、`inversion`、`pipeline`。
- `metadata.author` 必须说明维护负责人，可填写 GitLab 用户名、团队名或岗位角色。
- `metadata.version` 必须说明 Skill 自身维护版本，建议从 `1.0.0` 开始。
- 正文以中文为主，保留必要英文术语可以，但不要让英文成为主体。
- `SKILL.md` 只写触发后必须知道的流程和判断；详细资料放 `references/`，模板放 `templates/`，可复用静态素材放 `assets/`。

## 新增 Skill 流程

1. 先判断内容是否应该成为 Skill：只有可复用的 Agent 工作口径、流程、校验清单或领域知识才放入 `.agents/skills/`。
2. 选择两级路径：`.agents/skills/<顶级目录>/<技能目录>/SKILL.md`。
3. 让 `name` 和目录保持一致，并按主用途选择 `metadata.pattern`。
4. 用 `description` 写清楚这个 Skill 做什么，以及什么场景必须使用它。
5. 将正文控制为中文的执行规则、检查项和必要边界。
6. 若内容影响项目稳定能力契约，同步判断是否需要更新 OpenSpec。
7. 更新 `.agents/skills/README.md` 和根目录 `AGENTS.md` 的路由。

## 当前项目边界

- AI Gateway 启动、验证、客户端接入说明放在 `README.md`。
- AI 调用链路、模块分层、配置边界和演进路线放在 `docs/ai-structure.md`。
- Skill 目录规范、创建规则和治理流程放在 `.agents/skills/`。
- 代理行为、Demo API、鉴权、模型别名、上下文预算等稳定契约放在 `openspec/`。

## 校验清单

- `.agents/skills/README.md` 已列出新增或调整的 Skill。
- Skill 路径满足两级结构。
- `SKILL.md` frontmatter 字段完整。
- `name` 等于 `<顶级目录>-<技能目录>`。
- `metadata.pattern` 是主设计模式，不是路径。
- `metadata.author` 和 `metadata.version` 已填写。
- 正文没有把大量背景、历史讨论或一次性说明塞进 Skill。
- 没有新增 `.cursor/`、`.trae/`、`.qoder/`、`.vscode/` 或根目录 `skills/` 平行资产。

## 自动校验

修改 Skill 后运行：

```bash
node .agents/skills/company-public/skill-governance/scripts/validate-skills.mjs
```

若脚本失败，先修复结构、frontmatter 或命名问题，再继续处理业务文档或 OpenSpec。

