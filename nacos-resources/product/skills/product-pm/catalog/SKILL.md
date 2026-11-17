---
name: "product-pm-catalog"
description: "PM技能目录与原始名称映射。任务涉及整套能力导航、复合产品工作或原名查找时使用。"
license: "MIT"
metadata:
  pattern: "pipeline"
  author: "Mastra 实践维护者；上游 Pawel Huryn"
  version: "1.0.0"
  upstream: "pm-skills@2a12295a7717569baa7be181b4cfebe3ca38a6bb"
---

# 产品方法目录

先按任务选最少的方法：单项工作选原子 Skill，多阶段工作选 `flow-` Skill。原子方法和流程是111个上游入口的分别适配，流程命令不是自动审批或外部操作权限。产品稿交付仍调用 `product-requirements-handoff`。

用 `skill_read` 读取 `references/catalog.md` 可查原名、插件分类与本地名。选定方法后调用 `skill`，再读取该方法的 `references/upstream.md`；无需一次加载整个目录。

上游来源锁定、更新和许可说明见实践 Skill 索引。当前工具只提供方法和参考读取，不提供网络、Shell、SQL或任意业务文件访问；涉及这些步骤时须报告缺口。

## Shipping辅助资料

上游8项已迁移实现会引用下列3个辅助方法，它们是补充参考，不计入111项上游入口。原文的相对 `references/` 路径相对于各辅助方法目录，实际读取下列完整资源路径：

- `references/shipping/independent-review/method.md`：independent-review 的完整方法或分支参考；仅相关任务按需读取。
- `references/shipping/independent-review/scripts/review.py`：independent-review 的完整方法或分支参考；仅相关任务按需读取。
- `references/shipping/release-gate/method.md`：release-gate 的完整方法或分支参考；仅相关任务按需读取。
- `references/shipping/release-gate/references/checklist.md`：release-gate 的完整方法或分支参考；仅相关任务按需读取。
- `references/shipping/release-gate/references/go-live.md`：release-gate 的完整方法或分支参考；仅相关任务按需读取。
- `references/shipping/release-gate/references/netlify.md`：release-gate 的完整方法或分支参考；仅相关任务按需读取。
- `references/shipping/release-gate/references/runbook.md`：release-gate 的完整方法或分支参考；仅相关任务按需读取。
- `references/shipping/test-harness/method.md`：test-harness 的完整方法或分支参考；仅相关任务按需读取。
- `references/shipping/test-harness/references/captures.md`：test-harness 的完整方法或分支参考；仅相关任务按需读取。
- `references/shipping/test-harness/references/coverage-map.md`：test-harness 的完整方法或分支参考；仅相关任务按需读取。
- `references/shipping/test-harness/references/harnesses.md`：test-harness 的完整方法或分支参考；仅相关任务按需读取。
- `references/shipping/test-harness/references/rules-from-bugs.md`：test-harness 的完整方法或分支参考；仅相关任务按需读取。
- `references/shipping/test-harness/references/vendor-surfaces.md`：test-harness 的完整方法或分支参考；仅相关任务按需读取。
