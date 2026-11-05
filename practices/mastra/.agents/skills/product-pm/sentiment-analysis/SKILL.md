---
name: "product-pm-sentiment-analysis"
description: "用户反馈情感分析。用于用户反馈情感分析任务；产出情感与主题分布、群体差异及建议。"
license: "MIT"
metadata:
  pattern: "generator"
  author: "Mastra 实践维护者；上游 Pawel Huryn"
  version: "1.0.0"
  upstream: "pm-skills@2a12295a7717569baa7be181b4cfebe3ca38a6bb"
---

# 用户反馈情感分析

## 工作方法

清点全部反馈并按主题和用户群体归类；有证据时识别至少3类群体，给出−1到+1的情感口径、原话和频次，按频率、严重度及影响排序，样本不足不硬凑。

## 执行与完成标准

- 开始执行时，用 Mastra 原生 `skill_read` 读取本 Skill 的 `references/upstream.md`，核对完整方法、公式、模板和条件分支；仅按当前任务需要读取附属资料。英文原文保真保留，中文入口负责本宿主的执行适配。
- 交付：情感与主题分布、群体差异及建议。结论须能对应输入事实或明确标注的假设；用中文输出。
- `references/upstream.md` 内的 `$ARGUMENTS` 是当前用户任务及已提供上下文；插件斜杠命令按下方本地映射调用原生 `skill`。不要照原文安装插件、切换指定模型或生成下级 Agent。
- 方法中要求搜索、读仓库、计算、保存文件或运行命令时，只使用当前 Agent 实际注册且已授权的工具；缺少工具就列出缺少的材料或未执行步骤。静态分析、草稿、测试设计和发布计划不能作为实际执行/批准的证据。

## 参考资料与来源

- `references/upstream.md`：完整上游方法，按上述步骤读取。
- 来源：`pm-skills` 的 `pm-market-research/skills/sentiment-analysis/SKILL.md`，固定 commit `2a12295a7717569baa7be181b4cfebe3ca38a6bb`。MIT 原文见技能根目录 `licenses/`，本地路径及SHA256见 `upstream-lock.json`。
