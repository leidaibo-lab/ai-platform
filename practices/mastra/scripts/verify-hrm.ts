/** 对授权HRM当前源码运行独立Docker验证，不修改仓库、不使用宿主.env或数据库。 */
import { resolve, join } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { readRepositoryCatalog } from '../src/intake/repository-catalog.js';
import { assembleRepositoryProject } from '../src/intake/repository-project.js';
import { verifyHrm } from '../src/development/hrm-verification.js';
const root = resolve(process.argv[2] ?? '../../../hrm');
const catalog = readRepositoryCatalog(root);
if (!catalog.available) throw new Error(catalog.reason);
if (!catalog.executionReady) throw new Error(catalog.preparationIssues.join('；'));
const project = assembleRepositoryProject(root, catalog.catalogHash);
const result = await verifyHrm(project.files);
mkdirSync('.data', { recursive: true });
writeFileSync(join('.data', 'hrm-verification-result.json'), JSON.stringify({ repositoryVersion: catalog.revision, catalogHash: catalog.catalogHash, completedAt: new Date().toISOString(), checks: result }, null, 2));
console.log(JSON.stringify(result.map(/** 输出脱敏摘要，完整日志保留在忽略目录。 */item => ({ id: item.id, exitCode: item.exitCode, durationMs: item.durationMs, timedOut: item.timedOut })), null, 2));
if (result.length !== 3 || result.some(/** 任意缺失或失败都不能报告完整验证通过。 */item => item.exitCode !== 0)) process.exitCode = 1;
