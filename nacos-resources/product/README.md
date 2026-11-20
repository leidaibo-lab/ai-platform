# 产品角色 Nacos 资源候选

这个目录保存跨电脑共享的产品角色 Prompt、Skill 与来源记录。`manifest.json` 的 `activeSkills` 同时控制本地产品经理绑定和 Nacos 候选包，`reviewerSkills` 指定独立审查的子集。其余上游原文、入口及来源锁归档在 `skills/`，供维护者追溯。

`1.4.0` 是待审核、待发布的候选版本。产品经理使用需求对齐、平台需求交接、PRD 写作、用户故事拆分、验收场景及关键业务分支审查。独立审查使用两项交付规范、验收场景及关键业务分支审查。服务环境启用新版本时使用该包生成的完整绑定，已有 Run 按记录的版本恢复。

公司需求对齐 Skill 使用 `product-pm-product-requirements-alignment`。清单的 `alignmentSource` 固定公司 Skill 仓库提交和逐文件摘要。产品经理和独立审查的正式稿 Prompt 均要求读取 `references/delivery-writing.md`。

在仓库根目录生成 Skill 包及逐文件摘要：

```sh
npx tsx scripts/prepare-nacos-product-skills.ts .data/nacos-product-export-1.4.0 1.4.0
```

输出目录必须不存在。脚本核对来源锁和许可证、拒绝符号链接和不支持的文件布局，生成 6 个 ZIP、审查用 `manifest.json` 和不含凭据的 `runtime-bindings.json`。`.data/` 不被 Git 跟踪；请在每台电脑重新生成。应先审查 Prompt、Skill、许可和摘要，再通过有授权的 Nacos 管理流程上传及发布。

审查候选后，可向本机 Nacos 注册：在当前终端安全设置 `NACOS_PUBLISH_URL`（例如 `http://127.0.0.1:8848`）、`NACOS_PUBLISH_NAMESPACE`、`NACOS_PUBLISH_USERNAME` 和 `NACOS_PUBLISH_PASSWORD`，再执行：

```sh
npx tsx scripts/register-nacos-product-resources.ts .data/nacos-product-export-1.4.0 --apply
```

注册器只允许本机回环地址，不读取 `.env`，不保存凭据。它检查导出摘要、按精确版本读取已有资源，相同内容可重复执行，内容不同则停止；新资源按 Nacos 的状态流程发布。自动处理 Nacos 的审核状态不等于人工审核，操作前仍需审查候选资源。中断后可使用原导出目录再次执行。注册器会校验同版本 Skill 草稿的正文与引用，并通过正常提审和发布流程继续。内容不一致或审核未通过时停止。

2026-11-17 已在本机隔离 Nacos 3.3 完成 `1.0.0` 的两个候选 Prompt 和 113 个真实 Skill 的发布与读回。Nacos 会规范化 Skill frontmatter，注册器比较 Mastra 解析的元数据、指令与引用；运行快照仍校验实际下载内容的摘要。该结果不代替其他电脑上的注册和权限验证。不同电脑各自使用持久化 Nacos 时，需分别发布相同名称、精确版本和内容；版本发布后不得原地改写。Run 冻结既有版本，资源撤销或不可访问时停止而不是换用新版本。

注册成功后，将 `runtime-bindings.json` 中的名称、版本和 JSON 数组对应设置到应用进程环境变量中，并单独设置运行时 Nacos 地址、命名空间及只读账号。该文件本身不会被应用自动读取，也不包含连接信息和凭据。
