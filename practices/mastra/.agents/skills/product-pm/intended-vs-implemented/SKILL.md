---
name: "product-pm-intended-vs-implemented"
description: "设计意图与实现对照。用于设计意图与实现对照任务；产出意图—实现—测试差距表及证据。"
license: "MIT"
metadata:
  pattern: "reviewer"
  author: "Mastra 实践维护者；上游 Pawel Huryn"
  version: "1.0.0"
  upstream: "product-engineering@0e8b5a5fdd7155a5c440ade930c3e081eb387943"
---

# 设计意图与实现对照

## 工作方法

先从系统文档提取可检查规则，再追踪实现和测试证据；区分未实现、冲突、未文档化和资料不足，规则没有源码证据不能宣布落实。

## 执行与完成标准

- 开始执行时，用 Mastra 原生 `skill_read` 读取本 Skill 的 `references/upstream.md`，核对完整方法、公式、模板和条件分支；仅按当前任务需要读取附属资料。英文原文保真保留，中文入口负责本宿主的执行适配。
- 交付：意图—实现—测试差距表及证据。结论须能对应输入事实或明确标注的假设；用中文输出。
- `references/upstream.md` 内的 `$ARGUMENTS` 是当前用户任务及已提供上下文；插件斜杠命令按下方本地映射调用原生 `skill`。不要照原文安装插件、切换指定模型或生成下级 Agent。
- 方法中要求搜索、读仓库、计算、保存文件或运行命令时，只使用当前 Agent 实际注册且已授权的工具；缺少工具就列出缺少的材料或未执行步骤。静态分析、草稿、测试设计和发布计划不能作为实际执行/批准的证据。

## 本地方法映射

仅在当前分支实际需要时调用下列 Skill，不批量展开全部方法：

- `shipping-artifacts` → `product-pm-shipping-artifacts`

## 已迁移实现与辅助方法

`references/migration-notice.md` 保留原仓迁移提示；实际工作读取 `references/upstream.md`。原文的 `independent-review`、`release-gate`、`test-harness` 辅助方法及其引用放在 `product-pm-catalog` 的 `references/shipping/`；需要相应步骤时先加载该目录 Skill 并读取其明确资源路径。独立评审、执行测试或发布依赖实际工具，没有这些能力时明确未验证。

## 参考资料与来源

- `references/upstream.md`：完整上游方法，按上述步骤读取。
- 来源：`product-engineering` 的 `ai-shipping/skills/intended-vs-implemented/SKILL.md`，固定 commit `0e8b5a5fdd7155a5c440ade930c3e081eb387943`。MIT 原文见技能根目录 `licenses/`，本地路径及SHA256见 `upstream-lock.json`。
