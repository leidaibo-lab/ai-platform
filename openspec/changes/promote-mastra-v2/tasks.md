## 1. 基线与契约

- [x] 获取并固定 `origin/main` 的 `fa9715f` 完整基线。
- [x] 保存取消前的 v2 工作树与生成物，避免覆盖式丢失。
- [x] 建立根目录 Mastra 主线的迁移变更与稳定契约草案。

## 2. 目录迁移

- [x] 将根自研 Runtime、Demo、LiteLLM、场景、评测和旧稳定契约迁至 `practices/custom-exploration/`。
- [x] 将 `practices/mastra/` 的完整应用、工作台、测试、配置和依赖提升至根目录。
- [x] 合并共用 Skill，保留探索专属 Skill 的局部归属。
- [x] 更新根、实践与应用文档的路径、启动入口和适用范围。

## 3. 验证

- [x] 校验根 Mastra 类型、测试、工作台构建和 OpenSpec。
- [x] 校验探索实践的独立入口、引用路径和局部 OpenSpec。
- [x] 检查当前源码不再引用已迁移的 `practices/mastra/` 路径。
- [x] 以隔离数据目录启动根应用和工作台，确认端口与 Run API。
