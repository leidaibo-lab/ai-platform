---
name: "development-bmad-context"
description: "核实项目上下文与规则来源，用于受限开发准备阶段。"
license: "MIT"
metadata:
  pattern: "generator"
  author: "Mastra 实践维护者；上游 BMad Code Org"
  version: "1.0.0"
---

# 核实项目上下文与规则来源，用于受限开发准备阶段。

1. 读取 references/upstream.md，借鉴“规则必须可核实”的方法，再读取宿主提供的候选文件和批准产品。
2. 只提炼实际读取的规则、源码事实和未知项，每项引用文件路径或批准原文定位；不把常见技术习惯写成项目事实。
3. 分开稳定约束与当次源码事实。文件散列、产品版本和方法包版本由宿主绑定。
4. 输出宿主定义的规则/未知项 JSON。缺失的业务选择留给产品确认；代码能回答的问题先读代码。
5. 当前只生成上下文，不写 AGENTS.md、不执行上游配置脚本、不访谈、不委派、不另存状态。所有权限和批准由宿主 Workflow 决定。

来源：BMAD-METHOD 发布包 6.12.0，固定 commit `05bfbd46d00766ec88eb9b42e76be2c575d64d7b`。参考原文只作方法依据，禁止直接执行其宿主命令/状态/权限约定。依赖取舍与来源散列见 references/source-lock.json；MIT 原文见 references/LICENSE。
