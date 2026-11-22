/** 项目级交付落点；版本文件不可变，current 仅指向后续 Run 使用的版本。 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { PracticeConfig } from '../mastra/config.js';
import type { AssetCorrelation } from '../delivery/asset-identity.js';

const pathTemplate = z.string().min(1).max(200).refine(value => !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.startsWith('.')) && /^[a-zA-Z0-9_./{}-]+$/.test(value), '落点必须是仓库内安全相对路径');
export const projectDeliveryContractSchema = z.object({
  version: z.literal('project-delivery-contract.v1'),
  paths: z.object({
    requirements: pathTemplate,
    productSpecification: pathTemplate,
    developmentSource: pathTemplate,
    testingCases: pathTemplate,
    engineeringRules: pathTemplate,
  }).strict(),
}).strict().superRefine((contract, context) => {
  const { engineeringRules: _rules, ...otherPaths } = contract.paths;
  const values = Object.values(otherPaths);
  if (new Set(values).size !== values.length || [contract.paths.requirements, contract.paths.productSpecification].includes(contract.paths.engineeringRules)) context.addIssue({ code: 'custom', message: '文档与其他落点不能重复' });
  if (!contract.paths.requirements.includes('{iterationId}') || !contract.paths.productSpecification.includes('{iterationId}')) context.addIssue({ code: 'custom', message: '需求与产品规格落点必须包含 {iterationId}' });
  if (contract.paths.developmentSource.includes('{iterationId}') || contract.paths.testingCases.includes('{iterationId}') || contract.paths.engineeringRules.includes('{iterationId}')) context.addIssue({ code: 'custom', message: '代码、测试和工程规则落点必须是稳定目录' });
});
export type ProjectDeliveryContract = z.infer<typeof projectDeliveryContractSchema>;

export const defaultProjectDeliveryContract = projectDeliveryContractSchema.parse({ version: 'project-delivery-contract.v1', paths: { requirements: 'product/{iterationId}/requirements.md', productSpecification: 'product/{iterationId}/product-spec.md', developmentSource: 'src', testingCases: 'test', engineeringRules: 'specs' } });

/** 从已登记项目 Adapter 推导首次使用的源码与测试根目录。 */
export function defaultContractForAdapter(candidate: { writablePaths: string[]; checkFiles: string[]; instructionFiles?: string[] }): ProjectDeliveryContract {
  const source = candidate.writablePaths[0]?.split('/')[0] ?? 'src';
  const tests = candidate.checkFiles[0]?.split('/')[0] ?? 'test';
  const ruleRoots = [...new Set((candidate.instructionFiles ?? []).filter(path => path.includes('/')).map(path => path.split('/')[0]))];
  const rules = ruleRoots.length === 1 ? ruleRoots[0] : defaultProjectDeliveryContract.paths.engineeringRules;
  return projectDeliveryContractSchema.parse({ ...defaultProjectDeliveryContract, paths: { ...defaultProjectDeliveryContract.paths, developmentSource: source, testingCases: tests, engineeringRules: rules } });
}

/** 提取当前 Adapter 登记路径的父目录，供接入页面只读展示。 */
export function adapterDeliveryRoots(candidate: { writablePaths: string[]; checkFiles: string[] }) {
  return { developmentSource: [...new Set(candidate.writablePaths.map(path => path.slice(0, path.lastIndexOf('/'))))], testingCases: [...new Set(candidate.checkFiles.map(path => path.slice(0, path.lastIndexOf('/'))))] };
}

/** 确认配置根目录覆盖 Adapter 的全部源码与保护检查文件。 */
export function assertDeliveryContractMatchesAdapter(contract: ProjectDeliveryContract, candidate: { writablePaths: string[]; checkFiles: string[]; instructionFiles?: string[] }) {
  const inside = (path: string, root: string) => path.startsWith(`${root}/`);
  if (!candidate.writablePaths.every(path => inside(path, contract.paths.developmentSource)) || !candidate.writablePaths.some(path => inside(path, contract.paths.developmentSource))) throw new Error('开发代码落点必须包含当前 Adapter 登记的全部可写源码路径');
  if (!candidate.checkFiles.every(path => inside(path, contract.paths.testingCases)) || !candidate.checkFiles.some(path => inside(path, contract.paths.testingCases))) throw new Error('测试用例落点必须包含当前 Adapter 登记的全部保护检查路径');
  if (candidate.instructionFiles?.some(path => path.includes('/') && !inside(path, contract.paths.engineeringRules))) throw new Error('工程规则落点必须包含当前 Adapter 关联的目录规则');
}

/** 使用项目独立数据目录保存交付契约版本。 */
function contractDirectory(config: PracticeConfig) {
  if (!config.engineeringProject) throw new Error('交付契约必须绑定已登记项目');
  return resolve(dirname(config.databaseUrl.replace(/^file:/, '')), 'projects', config.engineeringProject.id, 'delivery-contracts');
}

/** 校验并读取不可变版本文件。 */
export function readProjectDeliveryContract(config: PracticeConfig, hash?: string, initial?: ProjectDeliveryContract): { contract: ProjectDeliveryContract; hash: string } {
  const directory = contractDirectory(config);
  const pointer = resolve(directory, 'current.json');
  let selected = hash;
  if (!selected && existsSync(pointer)) selected = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(JSON.parse(readFileSync(pointer, 'utf8'))).hash;
  if (!selected) return writeProjectDeliveryContract(config, initial ?? defaultProjectDeliveryContract);
  const file = resolve(directory, `${selected}.json`);
  if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error('Run 绑定的项目交付契约版本不可读取');
  const contract = projectDeliveryContractSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (contractHash(contract) !== selected) throw new Error('项目交付契约版本摘要不一致');
  return { contract, hash: selected };
}

/** 规范化 JSON 后生成不可变契约版本身份。 */
function contractHash(contract: ProjectDeliveryContract) { return createHash('sha256').update(JSON.stringify(contract)).digest('hex'); }

/** 保存新不可变版本并原子更新后续 Run 指针。 */
export function writeProjectDeliveryContract(config: PracticeConfig, value: unknown) {
  const contract = projectDeliveryContractSchema.parse(value);
  const hash = contractHash(contract);
  const directory = contractDirectory(config);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of [`${hash}.json`, 'current.json']) {
    const file = resolve(directory, name);
    if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())) throw new Error('交付契约存储必须为普通文件');
  }
  if (!existsSync(resolve(directory, `${hash}.json`))) writeAtomic(resolve(directory, `${hash}.json`), JSON.stringify(contract, null, 2) + '\n');
  writeAtomic(resolve(directory, 'current.json'), JSON.stringify({ version: 'project-delivery-contract-pointer.v1', hash }, null, 2) + '\n');
  return { contract, hash };
}

/** 使用独占临时文件替换配置，避免部分写入。 */
function writeAtomic(file: string, contents: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 }); renameSync(temporary, file); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** 根据 Run 冻结的摘要解析落点，旧 Run 保持兼容默认契约。 */
export function deliveryContractForRun(config: PracticeConfig, correlation?: AssetCorrelation) {
  const frozenHash = correlation?.deliveryContractHash;
  const result = frozenHash ? readProjectDeliveryContract(config, frozenHash) : { contract: defaultProjectDeliveryContract, hash: contractHash(defaultProjectDeliveryContract) };
  if (correlation?.deliveryContractVersion && correlation.deliveryContractVersion !== 'project-delivery-contract.v1') throw new Error('Run 项目交付契约版本不受支持');
  if (frozenHash && result.hash !== frozenHash) throw new Error('Run 项目交付契约绑定已变化');
  return result;
}

/** 仅将迭代标识替换为经过 schema 校验的路径片段。 */
export function resolveDeliveryPath(template: string, iterationId: string) { return template.replaceAll('{iterationId}', z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/).parse(iterationId)); }
