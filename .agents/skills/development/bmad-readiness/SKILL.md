---
name: "development-bmad-readiness"
description: "只读评估任务是否能在不臆造决定的前提下开工。"
license: "MIT"
metadata:
  pattern: "reviewer"
  author: "Mastra 实践维护者；上游 BMad Code Org"
  version: "1.0.0"
---

# 只读评估任务是否能在不臆造决定的前提下开工。

1. 读取 references/upstream.md，独立核对批准产品、上下文、方案与任务包。
2. 核心问题：开发者能否不臆造未记录的业务/架构决定就实现？双向追踪需求和任务，检查契约冲突、依赖与验收遗漏。
3. 缺文档本身不是问题；只有实现依赖其中缺失的决定才报告。已经明确的规则引用原文，不重复提问。
4. 输出 PASS、CONCERNS 或 FAIL 和逐条有引用依据的 findings。PASS 必须无发现；其他状态必须有发现。未检查维度显式列出。
5. 结果是建议，不是授权；宿主结构检查失败不能被模型或人工评论豁免。CONCERNS 进入逐项人工证据裁决；FAIL 返回业务澄清或人工处理，不能直接批准。
6. 不生成 sprint 状态、不写报告文件、不委派、不审批。

来源：BMAD-METHOD 发布包 6.12.0，固定 commit `05bfbd46d00766ec88eb9b42e76be2c575d64d7b`。参考原文只作方法依据，禁止直接执行其宿主命令/状态/权限约定。依赖取舍与来源散列见 references/source-lock.json；MIT 原文见 references/LICENSE。
