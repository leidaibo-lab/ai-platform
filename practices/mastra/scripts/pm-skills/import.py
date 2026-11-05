#!/usr/bin/env python3
"""从显式本地 checkout 生成锁定的 PM 资产；不联网，不自动覆盖上游版本决策。"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

PRACTICE = Path(__file__).resolve().parents[2]
TARGET = PRACTICE / '.agents/skills'
CURATION = json.loads(Path(__file__).with_name('curation.json').read_text())
PM_SHA = '2a12295a7717569baa7be181b4cfebe3ca38a6bb'
SHIPPING_SHA = '0e8b5a5fdd7155a5c440ade930c3e081eb387943'


def digest(data):
    """为原始字节生成稳定散列，检测来源和本地保真资产漂移。"""
    return hashlib.sha256(data).hexdigest()


def head(path):
    """只接受已锁定 checkout，不让版本升级隐式进入生成结果。"""
    return subprocess.check_output(['git', '-C', str(path), 'rev-parse', 'HEAD'], text=True).strip()


def write(path, text):
    """在受控资产根中写入 UTF-8 文本。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def copy(source, destination, source_root, repository):
    """逐字节复制参考文件并返回可审计来源记录。"""
    data = source.read_bytes()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    return {'repository': repository, 'sourcePath': source.relative_to(source_root).as_posix(),
            'localPath': destination.relative_to(TARGET).as_posix(), 'sha256': digest(data)}


def frontmatter(name, description, pattern, source):
    """生成满足公司规范的中文发现元数据。"""
    return f'''---
name: "{name}"
description: "{description}"
license: "MIT"
metadata:
  pattern: "{pattern}"
  author: "Mastra 实践维护者；上游 Pawel Huryn"
  version: "1.0.0"
  upstream: "{source}"
---
'''


def main():
    """完整盘点111项，复制来源与附属参考，生成中文入口和导航。"""
    if len(sys.argv) != 3:
        raise SystemExit('用法：python3 scripts/pm-skills/import.py <pm-skills checkout> <product-engineering checkout>')
    pm, shipping = [Path(value).resolve() for value in sys.argv[1:]]
    if head(pm) != PM_SHA or head(shipping) != SHIPPING_SHA:
        raise SystemExit('checkout SHA 与本次接受决策不符；请先审查升级并更新固定版本。')
    for checkout in [pm, shipping]:
        if subprocess.check_output(['git', '-C', str(checkout), 'status', '--porcelain', '--untracked-files=all'], text=True).strip():
            raise SystemExit('上游 checkout 含本地变更；请使用干净的固定版本来源。')
    sources = sorted([*pm.glob('pm-*/skills/*/SKILL.md'), *pm.glob('pm-*/commands/*.md')])
    if len(sources) != 111:
        raise SystemExit(f'上游入口数量变化：{len(sources)}，预期111')
    lock = {'schemaVersion': 1, 'adaptationVersion': '1.0.0', 'importedAt': '2026-11-06',
            'repositories': {
                'pm-skills': {'url': 'https://github.com/phuryn/pm-skills', 'commit': PM_SHA, 'version': '2.2.0'},
                'product-engineering': {'url': 'https://github.com/phuryn/product-engineering', 'commit': SHIPPING_SHA}},
            'licenses': [], 'entries': [], 'support': []}
    for root, filename, key in [(pm, 'LICENSE', 'pm-skills'), (shipping, 'LICENSE.md', 'product-engineering')]:
        lock['licenses'].append(copy(root / filename, TARGET / 'licenses' / f'{key}-MIT.txt', root, key))
    groups = {}
    for original in sources:
        relative = original.relative_to(pm)
        group, kind = relative.parts[:2]
        short = original.parent.name if kind == 'skills' else original.stem
        directory = short if kind == 'skills' else f'flow-{short}'
        name = f'product-pm-{directory}'
        title, method, *extra = CURATION['skills' if kind == 'skills' else 'flows'][short]
        dependencies = list(extra[0]) if kind == 'commands' else []
        source_root, repository, implementation = pm, 'pm-skills', original
        if group == 'pm-ai-shipping':
            source_root, repository = shipping, 'product-engineering'
            implementation = shipping / 'ai-shipping/skills' / short / 'SKILL.md'
        dest = TARGET / 'product-pm' / directory
        files = [copy(implementation, dest / 'references/upstream.md', source_root, repository)]
        if implementation != original:
            files.append(copy(original, dest / 'references/migration-notice.md', pm, 'pm-skills'))
        resources = []
        for source in sorted(implementation.parent.rglob('*')):
            if source.is_file() and source != implementation and (kind == 'skills' or repository == 'product-engineering'):
                rel = source.relative_to(implementation.parent)
                local = rel if rel.parts[0] == 'references' else Path('references/resources') / rel
                files.append(copy(source, dest / local, source_root, repository))
                resources.append(local.as_posix())
        # 上游提及的能力映射只作为按需发现线索，不递归加载全部依赖。
        text = implementation.read_text()
        mentioned = []
        for candidate in CURATION['skills']:
            if candidate != short and re.search(r'(?<![\w-])' + re.escape(candidate) + r'(?![\w-])', text):
                mentioned.append(candidate)
        for candidate in mentioned:
            if candidate not in dependencies:
                dependencies.append(candidate)
        mapping = '\n'.join(f'- `{dep}` → `product-pm-{dep}`' for dep in dependencies)
        ref_text = ''.join(f'- `{resource}`：原方法所引用的细节，涉及该分支时用 `skill_read` 读取。\n' for resource in resources)
        pattern = 'pipeline' if kind == 'commands' else 'reviewer' if short in {'strategy-red-team', 'code-review', 'intended-vs-implemented', 'pre-mortem', 'grammar-check', 'review-resume', 'ab-test-analysis'} else 'generator'
        body = frontmatter(name, f'{title}。用于{title}任务；产出{("流程结果及决策依据" if kind == "commands" else CURATION["skills"][short][2])}。', pattern, f'{repository}@{lock["repositories"][repository]["commit"]}')
        # 原子项第三字段为交付标准，流程第三字段为依赖名单。
        output = CURATION['skills'][short][2] if kind == 'skills' else '按下述流程形成可审查结果，保留中间选择、证据与未决项'
        body += f'''\n# {title}

## 工作方法

{method}

## 执行与完成标准

- 开始执行时，用 Mastra 原生 `skill_read` 读取本 Skill 的 `references/upstream.md`，核对完整方法、公式、模板和条件分支；仅按当前任务需要读取附属资料。英文原文保真保留，中文入口负责本宿主的执行适配。
- 交付：{output}。结论须能对应输入事实或明确标注的假设；用中文输出。
- `references/upstream.md` 内的 `$ARGUMENTS` 是当前用户任务及已提供上下文；插件斜杠命令按下方本地映射调用原生 `skill`。不要照原文安装插件、切换指定模型或生成下级 Agent。
- 方法中要求搜索、读仓库、计算、保存文件或运行命令时，只使用当前 Agent 实际注册且已授权的工具；缺少工具就列出缺少的材料或未执行步骤。静态分析、草稿、测试设计和发布计划不能作为实际执行/批准的证据。
'''
        if mapping:
            body += f'\n## 本地方法映射\n\n仅在当前分支实际需要时调用下列 Skill，不批量展开全部方法：\n\n{mapping}\n'
        if group == 'pm-ai-shipping':
            body += '\n## 已迁移实现与辅助方法\n\n`references/migration-notice.md` 保留原仓迁移提示；实际工作读取 `references/upstream.md`。原文的 `independent-review`、`release-gate`、`test-harness` 辅助方法及其引用放在 `product-pm-catalog` 的 `references/shipping/`；需要相应步骤时先加载该目录 Skill 并读取其明确资源路径。独立评审、执行测试或发布依赖实际工具，没有这些能力时明确未验证。\n'
        body += '\n## 参考资料与来源\n\n- `references/upstream.md`：完整上游方法，按上述步骤读取。\n' + ref_text
        body += f'- 来源：`{repository}` 的 `{implementation.relative_to(source_root).as_posix()}`，固定 commit `{lock["repositories"][repository]["commit"]}`。MIT 原文见技能根目录 `licenses/`，本地路径及SHA256见 `upstream-lock.json`。\n'
        write(dest / 'SKILL.md', body)
        entry = {'group': group, 'kind': kind, 'originalName': short, 'sourcePath': relative.as_posix(),
                 'sourceSha256': digest(original.read_bytes()), 'name': name,
                 'path': f'product-pm/{directory}', 'resolvedRepository': repository,
                 'resolvedPath': implementation.relative_to(source_root).as_posix(),
                 'dependencies': [f'product-pm-{dep}' for dep in dependencies], 'files': files}
        lock['entries'].append(entry)
        groups.setdefault(group, []).append((entry, title))
    # 只带入shipping8项实际提及的3个辅助方法，不另注册为上游入口。
    support_links = []
    for short in ['independent-review', 'release-gate', 'test-harness']:
        source_dir = shipping / 'ai-shipping/skills' / short
        for source in sorted(source_dir.rglob('*')):
            if not source.is_file():
                continue
            rel = source.relative_to(source_dir)
            local = Path('shipping') / short / ('method.md' if rel.as_posix() == 'SKILL.md' else rel)
            file = copy(source, TARGET / 'product-pm/catalog/references' / local, shipping, 'product-engineering')
            lock['support'].append(file)
            support_links.append(f'- `references/{local.as_posix()}`：{short} 的完整方法或分支参考；仅相关任务按需读取。')
    catalog = frontmatter('product-pm-catalog', 'PM技能目录与原始名称映射。任务涉及整套能力导航、复合产品工作或原名查找时使用。', 'pipeline', f'pm-skills@{PM_SHA}')
    catalog += '''
# 产品方法目录

先按任务选最少的方法：单项工作选原子 Skill，多阶段工作选 `flow-` Skill。原子方法和流程是111个上游入口的分别适配，流程命令不是自动审批或外部操作权限。产品稿交付仍调用 `product-requirements-handoff`。

用 `skill_read` 读取 `references/catalog.md` 可查原名、插件分类与本地名。选定方法后调用 `skill`，再读取该方法的 `references/upstream.md`；无需一次加载整个目录。

上游来源锁定、更新和许可说明见实践 Skill 索引。当前工具只提供方法和参考读取，不提供网络、Shell、SQL或任意业务文件访问；涉及这些步骤时须报告缺口。

## Shipping辅助资料

上游8项已迁移实现会引用下列3个辅助方法，它们是补充参考，不计入111项上游入口。原文的相对 `references/` 路径相对于各辅助方法目录，实际读取下列完整资源路径：

'''+ '\n'.join(support_links) + '\n'
    write(TARGET / 'product-pm/catalog/SKILL.md', catalog)
    rows = ['# 完整产品技能索引', '', '共69个原子Skill、42个流程Skill，另加本地导航Skill；产品Agent同时保留根需求交接Skill。', '']
    for group, entries in sorted(groups.items()):
        rows += [f'## {group}', '', '| 原名 | 类型 | 中文能力 | 本地 Skill |', '| --- | --- | --- | --- |']
        for e, title in entries:
            rows.append(f'| {e["originalName"]} | {e["kind"]} | {title} | `{e["name"]}` |')
        rows += ['']
    write(TARGET / 'product-pm/catalog/references/catalog.md', '\n'.join(rows))
    write(TARGET / 'README.md', '''# Mastra 产品 Skills

这是用户指定的独立实践 Skill 根，沿用公司两级目录和元数据规范。根探索 Skills 保留通用需求/实现交接方法，本套件只维护此一份。

- 69个原子能力、42个命令转换的流程能力，完整覆盖锁定版 pm-skills；另有1个本地导航，共112个本地 Skill。
- 产品 Agent 自动注册112项及原有需求交接，共113项；先匹配描述，再通过 Mastra 原生 `skill` / `skill_read` / `skill_search` 渐进读取。单次生成最多24步，达到限制仍未完成时不得声称完整流程通过。
- [完整能力目录](product-pm/catalog/references/catalog.md)逐项列出原始名称、分类和本地名称。原 commands 使用 `flow-` 前缀，避免与原子方法重名。
- `SKILL.md` 为中文工作入口；`references/upstream.md` 精确保留英文原文与模板；8个shipping迁移项使用新仓实际方法，并保留迁移提示。另有3个shipping辅助方法以目录Skill的参考资源提供。
- 原文的插件工具白名单、斜杠命令、固定模型、Agent委派、Shell和写路径均不自动授予本产品Agent能力。当前没有网络搜索、任意文件、数据库或代码/测试执行工具。需要这些步骤时输出缺失材料和未执行项；人工关口继续由Workflow掌握。
- 仅挂到产品 Agent；开发/测试/运维/只读阅读助手职责由原配置控制。导航不是另一个代理或运行时。

## 来源与维护

- pm-skills marketplace 2.2.0，commit `2a12295a7717569baa7be181b4cfebe3ca38a6bb`。
- shipping迁移实现：product-engineering commit `0e8b5a5fdd7155a5c440ade930c3e081eb387943`，仅使用8项迁移入口与3项辅助参考。
- [来源锁](upstream-lock.json)记录111项路径、依赖、解析后来源和逐文件SHA256；[pm-skills许可](licenses/pm-skills-MIT.txt)、[product-engineering许可](licenses/product-engineering-MIT.txt)保留MIT全文与作者。
- 中文策划源：`../../scripts/pm-skills/curation.json`；可复现导入器：`../../scripts/pm-skills/import.py`。导入器只接受已审查的两个固定checkout，不联网；更新先审查上游差异、许可、迁移及中文方法，再修改锁定版本并运行导入。
- 在实践根运行 `python3 scripts/pm-skills/import.py <pm-skills-checkout> <product-engineering-checkout>`；提交资产后运行 `npm run check`、`npm test`，在仓库根运行 Skill 治理校验。启动及测试不需要外部checkout。
- 真实模型的任务路由、全流程产品质量和成本需另以真实业务材料验证；确定性工具回归仅证明注册、读取和工作流边界。

'''+ '\n'.join(rows[4:]))
    write(TARGET / 'upstream-lock.json', json.dumps(lock, ensure_ascii=False, indent=2) + '\n')
    print(f'IMPORTED {len(lock["entries"])} upstream entries + 1 catalog; support files {len(lock["support"])}')


if __name__ == '__main__':
    main()
