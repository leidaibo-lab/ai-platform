---
name: "product-pm-shipping-artifacts"
description: "交付审查制品组织。用于交付审查制品组织任务；产出制品目录、位置、命名及证据关联。"
license: "MIT"
metadata:
  pattern: "generator"
  author: "Mastra 实践维护者；上游 Pawel Huryn"
  version: "1.0.0"
  upstream: "product-engineering@0e8b5a5fdd7155a5c440ade930c3e081eb387943"
---

# 交付审查制品组织

## 工作方法

先识别仓库既有文档、报告和发布位置，再按原文区分事实文档、审计报告与决策包；使用可追溯版本和命名，只有具备保存工具时写入，否则返回待保存内容。

## 执行与完成标准

- 开始执行时，用 Mastra 原生 `skill_read` 读取本 Skill 的 `references/upstream.md`，核对完整方法、公式、模板和条件分支；仅按当前任务需要读取附属资料。英文原文保真保留，中文入口负责本宿主的执行适配。
- 交付：制品目录、位置、命名及证据关联。结论须能对应输入事实或明确标注的假设；用中文输出。
- `references/upstream.md` 内的 `$ARGUMENTS` 是当前用户任务及已提供上下文；插件斜杠命令按下方本地映射调用原生 `skill`。不要照原文安装插件、切换指定模型或生成下级 Agent。
- 方法中要求搜索、读仓库、计算、保存文件或运行命令时，只使用当前 Agent 实际注册且已授权的工具；缺少工具就列出缺少的材料或未执行步骤。静态分析、草稿、测试设计和发布计划不能作为实际执行/批准的证据。

## 已迁移实现与辅助方法

`references/migration-notice.md` 保留原仓迁移提示；实际工作读取 `references/upstream.md`。原文的 `independent-review`、`release-gate`、`test-harness` 辅助方法及其引用放在 `product-pm-catalog` 的 `references/shipping/`；需要相应步骤时先加载该目录 Skill 并读取其明确资源路径。独立评审、执行测试或发布依赖实际工具，没有这些能力时明确未验证。

## 参考资料与来源

- `references/upstream.md`：完整上游方法，按上述步骤读取。
- 来源：`product-engineering` 的 `ai-shipping/skills/shipping-artifacts/SKILL.md`，固定 commit `0e8b5a5fdd7155a5c440ade930c3e081eb387943`。MIT 原文见技能根目录 `licenses/`，本地路径及SHA256见 `upstream-lock.json`。
