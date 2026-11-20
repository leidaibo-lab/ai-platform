---
name: "product-pm-create-prd"
description: "B 端功能 PRD 的写作与完整性检查，覆盖角色、范围、业务规则与验收。"
license: "MIT"
metadata:
  pattern: "generator"
  author: "Mastra 实践维护者；上游 Pawel Huryn"
  version: "1.1.0"
  upstream: "pm-skills@2a12295a7717569baa7be181b4cfebe3ca38a6bb"
---

# 产品需求文档

## 工作方法

先核对目标、适用角色和成功标准。对会改变范围、行为或验收的缺口提出问题，保留未决状态。正文写清范围、角色权限、主流程、状态变化、数据规则、异常及可观察的验收结果。

## 执行与完成标准

- 开始执行时，用 Mastra 原生 `skill_read` 读取本 Skill 的 `references/upstream.md`，核对完整方法、公式、模板和条件分支；从上游参考提取与模块当前问题相关的检查项。正式稿按项目的需求对齐与交接规范组织。
- 交付：按平台交接规范组织的 PRD、验收与未决项。结论须能对应输入事实或明确标注的假设；用中文输出。
- `references/upstream.md` 内的 `$ARGUMENTS` 是当前用户任务及已提供上下文。不要照原文安装插件、切换指定模型或生成下级 Agent。
- 方法中要求搜索、读仓库、计算、保存文件或运行命令时，只使用当前 Agent 实际注册且已授权的工具；缺少工具就列出缺少的材料或未执行步骤。静态分析、草稿、测试设计和发布计划不能作为实际执行/批准的证据。

## 参考资料与来源

- `references/upstream.md`：完整上游方法，按上述步骤读取。
- 来源：`pm-skills` 的 `pm-execution/skills/create-prd/SKILL.md`，固定 commit `2a12295a7717569baa7be181b4cfebe3ca38a6bb`。MIT 原文见技能根目录 `licenses/`，本地路径及SHA256见 `upstream-lock.json`。
