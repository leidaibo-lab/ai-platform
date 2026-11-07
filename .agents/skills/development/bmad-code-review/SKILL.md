---
name: "development-bmad-code-review"
description: "在固定检查之后只读评审意图一致性、边界与验证缺口。"
license: "MIT"
metadata:
  pattern: "reviewer"
  author: "Mastra 实践维护者；上游 BMad Code Org"
  version: "1.0.0"
---

# 在固定检查之后只读评审意图一致性、边界与验证缺口。

1. 读取 references/upstream.md 和所需检查维度参考。基于批准产品、任务、当前源码、变更文件及真实检查证据进行独立只读评审。
2. 检查意图到实现、异常/权限边界、删除影响和验证缺口。固定 smoke 通过不证明全部业务正确。
3. 每个发现记录稳定 ID、严重性、责任路由、可定位引用、具体坏结果和证据。不得只写“可能有风险”。
4. 原始发现不可删除；修复后由后续评审对相同发现给出 fixed/not-an-issue 及可核查依据。没有证据不能认定误报。
5. 输出宿主结构化报告，列出覆盖引用与未检查项；报告为空、解析失败或执行失败均不能当作无问题。仍有发现用 CONCERNS/FAIL。
6. 不自动改代码、不运行任意命令、不委派、不改规格、不审批或交付。修复和最终交付由宿主有界流程控制。

来源：BMAD-METHOD 发布包 6.12.0，固定 commit `05bfbd46d00766ec88eb9b42e76be2c575d64d7b`。参考原文只作方法依据，禁止直接执行其宿主命令/状态/权限约定。依赖取舍与来源散列见 references/source-lock.json；MIT 原文见 references/LICENSE。
