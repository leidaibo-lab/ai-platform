# 固定独立评审与缺陷返工专项

本专项冻结产品需求、上下文、架构任务包、就绪结果与单一backend角色，隔离考核只读代码评审和缺陷返工。采用已有v2原生Workflow、只读评审Agent、受限文件工具、真实Node沙箱与交付门；不另建编排器，不扩展动态组队/并行委派或生产批准权限。原生Dataset、Experiment、Scorer与Studio共用Store，逐例结果可在原生面板查看。

## 预登记案例

用例源为[cases.v1.json](./cases.v1.json)，候选源码、需求与独立oracle在[src/evaluation/review-rework.ts](../../../src/evaluation/review-rework.ts)。源码及用例散列参与数据集身份，原生实验按次追加，不覆盖历史。

| 案例 | 受控输入 | 必须观察到的行为 |
| --- | --- | --- |
| clean | 码点计数正确的实现 | 无业务缺陷发现、零返工交付、隐藏断言通过 |
| repair | 使用UTF-16长度，80个emoji被错误拒绝 | 独立评审自行发现并归属backend；一次真实修复、自检、复评绑定原缺陷ID；隐藏断言通过 |
| exhausted | 初始及返工后均受控注入同一缺陷 | 独立评审再次发现，预算耗尽停止，不能交付，隐藏断言仍失败 |

公开smoke仅检查普通输入，故意不足以发现Unicode边界。外部oracle在独立目录检查类型、空白、普通字符及Unicode上下边界，核对具名断言计数，结果不回填模型返工。模型只看已批准需求、实际源码与原生评审发现，不看隐藏结果。

## 执行与查看

```sh
# Node >=24；本机可在命令前设置 PATH=/opt/homebrew/bin:$PATH
npm run eval:review-rework -- --live
```

每次建立新的`.data/evaluations/review-rework-<时间>/`目录。manifest记录模型、方法包、源码和用例散列；逐例JSON保留Workflow Run、完整状态、每次角色调用的执行模式、源码注入记录、评审前后hash、自检证据及初末oracle。原生Experiment另外保存输入、输出、分数与结果，失败不剔除、不挑选成功重跑。

在Studio的Datasets选择“固定专项 · 独立评审与缺陷返工”，查看对应Experiment。原生评分器为`fixed-review-rework-v1`；实验completed仅表示执行完毕，三项都为1才使CLI成功退出。当前目标是CLI里的原生task，不能从面板直接重新运行业务；需通过上述CLI发起新实验。

三例可在评测层使用独立目录并发，单例业务链始终是固定单backend串行流程，这不代表动态开发并行能力通过。

## 证据与边界

- **controlled-fixture**：产品、上下文、架构、就绪、首轮backend候选及自检解说为固定夹具。方法工具与文件I/O按原流程实际运行，但固定模型输出不计真实质量通过。
- **live**：只读reviewer与返工轮次backend调用正式模型，使用生产角色Prompt、方法、工具白名单与Workflow路由。所有实际自检由宿主在OS沙箱执行；只读评审前后hash必须一致。
- **controlled injection**：初始缺陷及exhausted每轮缺陷由评测宿主显式写入，注入次数和hash可查。不是模型自然产生缺陷的概率测量，也不是全链真实模型基线。
- **fixture regression**：测试中使用合成评审结论验证控制流与评分反例，和live实验分开。不能用这3项测试计数宣称真实评审质量通过。
- **独立性**：评审是独立只读角色调用，不持有写工具；与修复者可使用相同配置模型，不代表不同模型或人工独立审查。

评分检查正确缺陷类别/责任/文件引用、真实rework门、当前自检hash、评审只读、原报告ID的后续修复结论、最终源码hash及隐藏断言。未解决发现不能靠新的PASS覆盖；延期、人工接受不能冒充修复。

数据所有权继续由原生Workflow/Store承担；专项Adapter只拥有固定输入、受控源码注入和证据投影。复用既有流程而非新评测引擎，避免重复维护；不改变探索主线OpenSpec。维护归Mastra实践维护者，删除专项入口和评分器即可停止接入，历史原生实验保留。需要多文件跨角色返工、架构重规划、生产业务或真实上游集成时重新评估范围。

本轮实际结果见[2026-11-07专项记录](./observations-2026-11-07.md)。
