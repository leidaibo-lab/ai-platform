# 2026-11-07 固定评审与返工专项观察

## 结论

三项专项已接入Mastra原生Dataset/Experiment/Scorer，真实运行结果为 **2/3通过、1/3未通过**。真实只读评审已发现预置Unicode缺陷并正确归属backend，真实修复后的源码通过隐藏断言，但该例复评报告校验失败，保持暂停，无交付产物。没有放宽门禁，也没有自动重复模型调用挑成功。

## 执行证据

- Dataset：`fixed-review-rework.v1-04c30703a32a`
- Experiment：`c40449d3-79a0-44ca-a695-f1aabe957dab`
- Scorer：`fixed-review-rework-v1`
- 本地证据：`.data/evaluations/review-rework-2026-11-07T12-51-07-759Z/`
- authority：`controlled-upstream-real-review-and-repair`

Studio同一原生Store保存逐项输入、输出和分数。已从原生API确认该数据集的1次实验及3条评分可读取，未进行浏览器目视验收。实验completed表示三项执行/收集完成，不表示三个子Workflow均已成功交付；CLI因存在0分按预期退出1。

| 案例 | 真实评审及返工观察 | 隐藏断言：初始→最终 | 流程结果 | 专项分数 |
| --- | --- | --- | --- | --- |
| clean | 只读评审PASS，无发现，零返工 | 通过→通过 | development-delivered | 1 |
| repair | 发现F-001；正确归属backend；一次真实修复为Array.from计数；重新自检完成；复评输出校验失败 | 失败→通过 | suspended / review-code / invalid-output，无交付 | 0 |
| exhausted | 两次真实评审均发现F001仍存在；宿主在返工后重新注入同一缺陷 | 失败→失败 | rework-exhausted，无交付 | 1 |

运行ID：clean为`b785c6f0-bb76-48f0-843e-1cdf4bae2a6c`，repair为`2490c64b-12c4-40e3-86c4-82454a68d661`，exhausted为`e0fb8165-86f7-4910-9ba6-320b11ee20db`。各自原生Workflow库保存在案例目录。

### 缺陷发现证据

repair首轮评审明确指出JavaScript的`title.length`统计UTF-16码元，`"😀".repeat(41)`只有41个码点，应被接受却会因82个码元被拒绝；报告引用批准需求、backend任务、实际源码和smoke文件，并说明当前smoke通过不能排除此问题。该发现不是评测器注入报告，也未把隐藏oracle返回给模型。

### 修复成功但交付失败

backend实际把长度统计修复为`Array.from(title).length`，最终外部oracle三项具名类型/长度/Unicode测试通过。源码检查点已变化，自检重新执行，评审前后源码hash一致。

但复评没有成为有效的第二份codeReview，既有恢复事实为`phase=review-code, role=reviewer, kind=invalid-output, diagnostic={stage:json,code:json-invalid}`。现有诊断会把未细分的SyntaxError也归为json-invalid，所以**不能据此断言是JSON语法问题**，也不能定位为特定未知引用。失败正文按既有边界未保存，保留校验分类、检查点及原生暂停事实；不编造原始失败内容。

需要下一步单独改善报告约束诊断，并在一次受控恢复中验证复评。当前没有自动恢复、没有把旧发现标为已修复，也没有将其判为能力通过。新增回归明确验证：即使代码隐藏断言通过，只要复评无效，就必须暂停且专项得0分。

## 确定性与工程验证

- 新增专项4项测试通过：干净、修复、持续缺陷停止，以及修复后无效复评仍阻断。
- 前三项已纳入全实践回归，146/146通过；随后增加的无效复评回归及其余专项共4项重跑通过。没有宣称147项全量已重跑。
- TypeScript与git diff --check通过。
- 测试中的合成评审只用于确定性控制流，和本次真实模型输出分开。

## 适用边界

上游产品、context、architecture、readiness、首轮候选与self-check解说为受控夹具；真实模型只承担reviewer和返工backend。exhausted的持久缺陷是宿主反例注入，不是模型修复自然失败率。没有运行动态团队、跨角色依赖返工、重规划或全链真实上游，也没有独立人工评审或生产准入。

数据结构由InputV2/StateV2及专项固定scenario约束，原生Store持有事实；评测Adapter只控制输入、注入和证据收集。沿用既有Workflow与Scorer工厂，未另建编排器；输入生成、真实调用、隐藏验收和判分分离，遵循单一职责与最小实现原则。维护归Mastra实践维护者。
