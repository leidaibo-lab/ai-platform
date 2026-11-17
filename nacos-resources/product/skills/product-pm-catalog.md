# Mastra 产品 Skills

产品 Skill 套件位于 `product-pm/<技能>/SKILL.md`，其中包含 69 个原子能力、42 个流程能力和 1 个本地导航能力。运行时只将这些二级目录加载为 Skill；本文件保留在套件目录之外，避免被当作无效 Skill。

- [完整能力目录](./product-pm/catalog/references/catalog.md)列出原始名称、分类和本地名称。
- `upstream-lock.json` 记录锁定来源、路径与逐文件 SHA256。
- `licenses/` 保留 pm-skills 与 product-engineering 的 MIT 声明。
- `scripts/pm-skills/import.py` 是离线导入器，只接受已审查的固定 checkout，不联网。

产品 Agent 按任务渐进读取 Skill；Skill 不自动授予网络、任意文件、Shell、数据库、部署或审批权限。产品交付仍由 Workflow 的人工关口和根主线规则约束。
