---
name: "development-bmad-task-handoff"
description: "将批准需求和项目上下文转成有验收引用的开发任务包。"
license: "MIT"
metadata:
  pattern: "generator"
  author: "Mastra 实践维护者；上游 BMad Code Org"
  version: "1.0.0"
---

# 将批准需求和项目上下文转成有验收引用的开发任务包。

1. 读取 references/upstream.md，借鉴冻结意图、代码地图、任务与验收、验证的分离方法。
2. 从宿主的批准原文索引引用需求和验收，不重写另一份 PRD；缺少业务决定时列 blockers，不能以假设补齐。
3. 每个任务给出稳定 ID、角色、精确路径、前置依赖、requirementRefs、acceptanceRefs、contextRefs、constraints 和 verificationRefs。
4. 所有引用只能选择宿主给出的索引和已登记检查；检查引用不等于新增 shell 权限。按拓扑排序，每个文件只有一个负责人。
5. 明确正常、异常和边界行为，避免只列文件；任务、契约与上下文保持一致。
6. 输出宿主 schema。上游规格写入、状态文件、委派、Shell 和交互检查点均由宿主替代，本 Skill 不执行这些动作。

来源：BMAD-METHOD 发布包 6.12.0，固定 commit `05bfbd46d00766ec88eb9b42e76be2c575d64d7b`。参考原文只作方法依据，禁止直接执行其宿主命令/状态/权限约定。依赖取舍与来源散列见 references/source-lock.json；MIT 原文见 references/LICENSE。
