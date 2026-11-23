# 研发 live 合成场景 v1

20 个组织者定义的合成需求覆盖文本、权限、数据投影、库存、分页、重试和状态处理。每例提供公开 smoke 和三条独立判定输入；规则不代表真实业务批准。场景是无外部依赖的 Node.js 函数切片，不代表真实数据库、并发、浏览器或完整工程质量。沿用上级目录的人工量表；20 例不足以单独满足现有至少 24 个不同案例的试点准入门槛。

```sh
# 单例 fixture 检查流程
npm run eval:development -- --suite live-20 --cases live-01 --rounds 1
# 单例真实模型，先检查凭据、模型和费用
npm run eval:development -- --suite live-20 --live --cases live-01 --rounds 1
# 20 例各一轮，最多四路并发
npm run eval:development -- --suite live-20 --live --rounds 1 --concurrency 4
```

输出保存在新的 `.data/evaluations/` 子目录，manifest 记录套件、输入、oracle、量表和源码散列。自动批准只属于隔离评测策略；人工评分需独立完成。修改案例或判据后应版本化并新建运行，不覆盖旧结果。
