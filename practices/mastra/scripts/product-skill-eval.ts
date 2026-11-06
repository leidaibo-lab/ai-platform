import { execFileSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createAgents } from '../src/mastra/agents/index.js';
import { PRODUCT_MAX_STEPS } from '../src/mastra/agents/skills.js';
import { readConfig } from '../src/mastra/config.js';
import { createRecruitmentWorkspace, recruitmentSourcePath } from '../src/mastra/project-workspaces.js';
import { evaluationModelSettings, inputsSchema, pricingSchema, reviewSchema, rubricSchema, runProductSkillTrial, sha256, summarize, usage,
  type HumanReview, type TrialEntry, type Variant } from '../src/product-skill-evaluation.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const assets = resolve(root, 'evaluations/product-skills');

/** 临时文件替换避免中断留下半份 JSON。 */
function save(path: string, value: unknown): void {
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(path + '.tmp', path);
}

/** 读取明确指定的资产；调用方使用对应 schema 校验。 */
function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 散列只覆盖方法原文及参考资源，不扫描配置或凭据。 */
function fingerprint(directory: string, base = directory): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    // 相同字节内容和路径生成稳定清单。
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, fingerprint(path, base));
    else if (entry.isFile()) files[relative(base, path)] = sha256(readFileSync(path, 'utf8'));
    else throw new Error('评测资产不能包含符号链接');
  }
  return files;
}

/** 生成物仅存入本实践被忽略的隔离目录。 */
function evaluationPath(path: string): string {
  const output = resolve(root, path);
  const within = relative(resolve(root, '.data/evaluations'), output);
  if (!within || within.startsWith('..') || within.startsWith('/')) throw new Error('输出目录须位于 .data/evaluations/<run>');
  return output;
}

/** 可以反复汇总，未完成人工项保持待评，单价通过显式文件提供。 */
function report(directory: string, pricingPath?: string) {
  const entries = json(resolve(directory, 'organizer/trials.json')) as TrialEntry[];
  const rubric = rubricSchema.parse(json(resolve(directory, 'review/rubric.json')));
  const manifest = json(resolve(directory, 'organizer/manifest.json')) as { mode: string; rubricHash: string };
  if (sha256(JSON.stringify(rubric)) !== manifest.rubricHash) throw new Error('运行后量表被修改');
  const reviews = reviewSchema.parse(json(resolve(directory, 'review/reviews.json')));
  const pricing = pricingPath ? pricingSchema.parse(json(resolve(root, pricingPath))) : undefined;
  const summary = { mode: manifest.mode, ...summarize(entries, reviews, rubric, pricing) };
  save(resolve(directory, 'organizer/report.json'), summary);
  return summary;
}

/**
 * 专用配对脚本复用正式原生 Workflow；每个样本执行后保存，人工数据不传入模型。
 * 组织者拥有分组映射，审阅者仅获得 review/，运行不会恢复审批或进入开发。
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { live: { type: 'boolean', default: false }, rounds: { type: 'string', default: '1' },
    cases: { type: 'string' }, workspace: { type: 'boolean', default: false }, out: { type: 'string' }, report: { type: 'string' }, pricing: { type: 'string' } } });
  if (values.report) {
    const directory = evaluationPath(values.report);
    console.log(JSON.stringify({ directory, ...report(directory, values.pricing) }, null, 2));
    return;
  }
  const inputs = inputsSchema.parse(json(resolve(assets, 'inputs.json')));
  const rubric = rubricSchema.parse(json(resolve(assets, 'rubric.json')));
  const rounds = Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('轮数应为 1–5');
  const selected = values.cases?.split(',') ?? inputs.cases.map(
    // 默认运行登记的三个 pilot 案例。
    (item) => item.id,
  );
  const cases = inputs.cases.filter(
    // 两组使用相同输入，不拼入隐藏量表。
    (item) => selected.includes(item.id),
  );
  if (new Set(selected).size !== selected.length || cases.length !== selected.length) throw new Error('未知或重复案例');
  if (values.workspace && (selected.length !== 1 || selected[0] !== 'recruitment')) throw new Error('Workspace 评测仅支持 --cases recruitment');
  for (const item of cases) if (!rubric.cases[item.id]) throw new Error('缺少量表');
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const directory = evaluationPath(values.out ?? '.data/evaluations/product-skills-' + stamp);
  mkdirSync(resolve(directory, '..'), { recursive: true });
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(resolve(directory, 'organizer'));
  mkdirSync(resolve(directory, 'review/documents'), { recursive: true });
  process.env.MASTRA_MODE = values.live ? 'live' : 'fixture';
  process.env.MASTRA_DATA_DIR = resolve(directory, 'configuration');
  const config = readConfig();
  const sourceSnapshot = resolve(directory, 'organizer/sources');
  let sourceHashes: Record<string, string> = {};
  if (values.workspace) {
    const sources = resolve(root, recruitmentSourcePath);
    fingerprint(sources); // 复制前拒绝符号链接，不把其他目录带入评测。
    cpSync(sources, sourceSnapshot, { recursive: true, errorOnExist: true, force: false });
    sourceHashes = fingerprint(sourceSnapshot);
  }
  const workspace = values.workspace ? createRecruitmentWorkspace(root, sourceSnapshot) : false;
  const entries: TrialEntry[] = [];
  let pairIndex = 0;
  for (let round = 1; round <= rounds; round++) {
    for (const item of cases) {
      const variants: Variant[] = pairIndex++ % 2 === 0 ? ['without-skills', 'with-skills'] : ['with-skills', 'without-skills'];
      for (const variant of variants) entries.push({ sampleId: randomUUID(), caseId: item.id, pairId: item.id + ':' + round, variant, result: null });
    }
  }
  const prompts: Record<string, unknown> = {};
  for (const variant of ['without-skills', 'with-skills'] as const) {
    const agents = createAgents(config, { skillsEnabled: variant === 'with-skills', workspace });
    const instructions: Record<string, unknown> = {};
    for (const [key, agent] of Object.entries(agents)) if (key.startsWith('product')) instructions[key] = await agent.getInstructions();
    prompts[variant] = instructions;
  }
  const codeHashes: Record<string, string> = {};
  for (const path of ['src/mastra/agents/index.ts', 'src/mastra/agents/product-roles.ts', 'src/mastra/agents/skills.ts',
    'src/mastra/workflows/product.ts', 'src/mastra/workflows/product-contract.ts', 'src/mastra/workflows/delivery.ts',
    'src/mastra/project-workspaces.ts', 'src/product-skill-evaluation.ts', 'scripts/product-skill-eval.ts', 'package-lock.json']) codeHashes[path] = sha256(readFileSync(resolve(root, path), 'utf8'));
  save(resolve(directory, 'organizer/manifest.json'), {
    createdAt: new Date().toISOString(), mode: config.mode, requestedModel: config.modelId,
    gitRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    modelSettings: evaluationModelSettings, maxStepsPerRole: PRODUCT_MAX_STEPS, concurrency: 1, rounds,
    inputsVersion: inputs.version, inputsHash: sha256(JSON.stringify(inputs)), rubricHash: sha256(JSON.stringify(rubric)), selectedCases: selected,
    workspace: { enabled: values.workspace, sources: sourceHashes, snapshot: values.workspace ? 'organizer/sources' : null },
    prompts, sourceHashes: codeHashes, skillHashes: { suite: fingerprint(resolve(root, '.agents/skills')),
      handoff: fingerprint(resolve(root, '../../.agents/skills/product/requirements-handoff')) },
    scope: '完整产品 Skill 包（113项）及调用指引的增量效果，不拆分单项方法贡献',
    blinding: '分组映射隐藏；方法引用可能泄露分组，同一审阅者可能存在学习效应',
  });
  save(resolve(directory, 'organizer/inputs.json'), inputs);
  save(resolve(directory, 'organizer/trials.json'), entries);
  save(resolve(directory, 'review/rubric.json'), rubric);
  const reviews: HumanReview[] = [];
  for (const entry of entries) reviews.push({ sampleId: entry.sampleId, caseId: entry.caseId, reviewer: null, firstPass: null, reviewSeconds: null,
    // 未评项必须为 null，不能默认零遗漏或通过。
    coverage: rubric.cases[entry.caseId].map((item) => ({ id: item.id, status: null, evidence: '' })), additionalDefects: [] });
  for (let i = reviews.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [reviews[i], reviews[j]] = [reviews[j], reviews[i]];
  }
  save(resolve(directory, 'review/reviews.json'), reviews);
  writeFileSync(resolve(directory, 'review/README.md'), readFileSync(resolve(assets, 'reviewer-guide.md'), 'utf8'));
  console.log(JSON.stringify({ directory, mode: config.mode, requestedModel: config.modelId, planned: entries.length }));
  for (const entry of entries) {
    if (values.workspace && JSON.stringify(fingerprint(sourceSnapshot)) !== JSON.stringify(sourceHashes)) throw new Error('Workspace 资料快照被修改');
    const item = cases.find(
      // 不附加历史项目 README 或评审答案。
      (candidate) => candidate.id === entry.caseId,
    )!;
    mkdirSync(resolve(directory, 'organizer', entry.sampleId));
    console.log(JSON.stringify({ sampleId: entry.sampleId, caseId: entry.caseId, variant: entry.variant, status: 'started' }));
    entry.result = await runProductSkillTrial({ ...config, databaseUrl: 'file:' + resolve(directory, 'organizer', entry.sampleId, 'workflow.db') }, entry.variant, item.brief, workspace);
    save(resolve(directory, 'organizer/trials.json'), entries);
    const content = '# 原始诉求\n\n' + item.brief + '\n\n---\n\n# 待审产品稿\n\n' + (entry.result.artifact ?? '未生成可审阅稿。人工指标保留 null，由组织者记录系统失败。') + '\n';
    writeFileSync(resolve(directory, 'review/documents', entry.sampleId + '.md'), content);
    report(directory, values.pricing);
    console.log(JSON.stringify({ sampleId: entry.sampleId, status: entry.result.status, elapsedMs: entry.result.elapsedMs, usage: usage(entry.result) }));
  }
  console.log(JSON.stringify({ directory, groups: report(directory, values.pricing).groups, humanReview: 'pending; review/README.md' }, null, 2));
}

// 供应商错误可能含敏感数据，入口只报告清晰的配置错误或固定失败说明。
main().catch((error: unknown) => {
  console.error(error instanceof Error && error.message.startsWith('真实模型尚未配置') ? error.message : '产品 Skill 评测未完成；检查参数与本地结果，人工指标不得补造。');
  process.exitCode = 1;
});
