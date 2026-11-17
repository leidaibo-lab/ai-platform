---
name: "product-pm-create-prd"
description: "精简产品需求文档。用于精简产品需求文档任务；产出可决策的八节PRD、验收与未决项。"
license: "MIT"
metadata:
  pattern: "generator"
  author: "Mastra 实践维护者；上游 Pawel Huryn"
  version: "1.0.0"
  upstream: "pm-skills@2a12295a7717569baa7be181b4cfebe3ca38a6bb"
---

# 精简产品需求文档

## 工作方法

缺少问题证据、目标用户或成功标准时，仅向用户问至多3个关键问题；用户要求直接推进才以明确假设起草。默认1至2页八节：摘要、联系人、背景、目标、市场细分、六段JTBD价值主张、方案、发布；用户与价值主张不可省略。

## 执行与完成标准

- 开始执行时，用 Mastra 原生 `skill_read` 读取本 Skill 的 `references/upstream.md`，核对完整方法、公式、模板和条件分支；仅按当前任务需要读取附属资料。英文原文保真保留，中文入口负责本宿主的执行适配。
- 交付：可决策的八节PRD、验收与未决项。结论须能对应输入事实或明确标注的假设；用中文输出。
- `references/upstream.md` 内的 `$ARGUMENTS` 是当前用户任务及已提供上下文；插件斜杠命令按下方本地映射调用原生 `skill`。不要照原文安装插件、切换指定模型或生成下级 Agent。
- 方法中要求搜索、读仓库、计算、保存文件或运行命令时，只使用当前 Agent 实际注册且已授权的工具；缺少工具就列出缺少的材料或未执行步骤。静态分析、草稿、测试设计和发布计划不能作为实际执行/批准的证据。

## 本地方法映射

仅在当前分支实际需要时调用下列 Skill，不批量展开全部方法：

- `product-strategy` → `product-pm-product-strategy`
- `value-proposition` → `product-pm-value-proposition`
- `product-name` → `product-pm-product-name`

## 参考资料与来源

- `references/upstream.md`：完整上游方法，按上述步骤读取。
- 来源：`pm-skills` 的 `pm-execution/skills/create-prd/SKILL.md`，固定 commit `2a12295a7717569baa7be181b4cfebe3ca38a6bb`。MIT 原文见技能根目录 `licenses/`，本地路径及SHA256见 `upstream-lock.json`。
