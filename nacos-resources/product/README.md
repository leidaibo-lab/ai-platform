# 产品角色 Nacos 资源候选

这个目录保存跨电脑共享的产品角色 Prompt、资源声明和 Skill 唯一来源。`skills/` 包含 113 个 Skill 正文、参考资料、来源锁和许可证；`manifest.json` 指向这一份来源。拉取整个仓库后可在每台电脑重新生成内容清单和导入包。

当前为**待审核、未发布的候选资源**。`1.1.0` 是候选版本，不等于 Nacos 已发布版本；本目录不保存凭据。现有 Prompt 只是两个角色的候选正文，阶段、澄清和阻塞回流等 Prompt 尚未全部迁出代码。

在仓库根目录生成 Skill 包及逐文件摘要：

```sh
npx tsx scripts/prepare-nacos-product-skills.ts .data/nacos-product-export-1.1.0 1.1.0
```

输出目录必须不存在。脚本核对来源锁和许可证、拒绝符号链接和不支持的文件布局，生成 113 个 ZIP、审查用 `manifest.json` 和不含凭据的 `runtime-bindings.json`。`.data/` 不被 Git 跟踪；请在每台电脑重新生成。应先审查 Prompt、Skill、许可和摘要，再通过有授权的 Nacos 管理流程上传及发布。

审查候选后，可向本机 Nacos 注册：在当前终端安全设置 `NACOS_PUBLISH_URL`（例如 `http://127.0.0.1:8848`）、`NACOS_PUBLISH_NAMESPACE`、`NACOS_PUBLISH_USERNAME` 和 `NACOS_PUBLISH_PASSWORD`，再执行：

```sh
npx tsx scripts/register-nacos-product-resources.ts .data/nacos-product-export-1.1.0 --apply
```

注册器只允许本机回环地址，不读取 `.env`，不保存凭据。它检查导出摘要、按精确版本读取已有资源，相同内容可重复执行，内容不同则停止；新资源按 Nacos 的状态流程发布。自动处理 Nacos 的审核状态不等于人工审核，操作前仍需审查候选资源。中断后可再次执行；如果同版本已有未上线的草稿，需先在 Nacos 中处理后再重试。

2026-11-17 已在本机隔离 Nacos 3.3 完成 `1.0.0` 的两个候选 Prompt 和 113 个真实 Skill 的发布与读回。Nacos 会规范化 Skill frontmatter，注册器比较 Mastra 解析的元数据、指令与引用；运行快照仍校验实际下载内容的摘要。该结果不代替其他电脑上的注册和权限验证。不同电脑各自使用持久化 Nacos 时，需分别发布相同名称、精确版本和内容；版本发布后不得原地改写。Run 冻结既有版本，资源撤销或不可访问时停止而不是换用新版本。

注册成功后，将 `runtime-bindings.json` 中的名称、版本和 JSON 数组对应设置到应用进程环境变量中，并单独设置运行时 Nacos 地址、命名空间及只读账号。该文件本身不会被应用自动读取，也不包含连接信息和凭据。
