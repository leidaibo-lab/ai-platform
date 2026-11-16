/** Docker验证扩展复用原生文件I/O与步骤生命周期，新增文件只在批准源码根内。 */
import { DevelopmentExecution } from '../development-execution.js';
import type { DevelopmentInput } from './contracts.js';
import { safePathSchema } from './contracts.js';
import { verifyHrm } from './hrm-verification.js';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** 项目配置只由服务端仓库装配器产生，角色任务仍经原有工具白名单限制。 */
class HrmExecution extends DevelopmentExecution {
  private stopped = false;
  /** 保留项目级权限上界，实际模型仅获得批准任务paths。 */
  constructor(root: string, private readonly project: DevelopmentInput['project']) { super(root, project.writablePaths, project.checkFiles); }
  /** 允许架构Agent声明的新增文件，但绝不允许修改检查、锁文件及范围外文件。 */
  override async writeFile(path: string, content: string) {
    if (this.stopped) throw new Error('HRM候选环境已关闭');
    if (this.project.preparationIssues?.length) throw new Error('工程准备未完成，当前候选仅允许只读规划');
    safePathSchema.parse(path);
    if (this.project.checkFiles.includes(path) || !this.project.writableRoots?.some(/** 写入上界由项目授权指定，不来自模型。 */root => path.startsWith(`${root}/`)) || Buffer.byteLength(content) > 100000) throw new Error('写入超出HRM源码范围');
    let cursor = this.root;
    for (const part of path.split('/')) { cursor = join(cursor, part); if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('HRM候选路径包含链接'); }
    mkdirSync(dirname(cursor), { recursive: true }); writeFileSync(cursor, content);
  }
  /** 关闭后禁止通过扩展写入路径继续修改候选。 */
  override async close() { try { await super.close(); } finally { this.stopped = true; } }
  /** 验证使用源快照副本，Docker产物不写回模型候选源码。 */
  override async runChecks() {
    if (this.project.preparationIssues?.length) throw new Error('工程准备未完成，不能运行项目验证');
    const before = await this.snapshot(); const files: Record<string, string> = {};
    for (const path of Object.keys(before)) files[path] = await this.readFile(path);
    return verifyHrm(files);
  }
}
/** CLI/fixture沿用原执行器；HRM全栈档才进入固定Docker验证。 */
export function createDevelopmentExecution(root: string, project: DevelopmentInput['project']): DevelopmentExecution {
  return project.executionProfile === 'hrm-pnpm-docker-v1' ? new HrmExecution(root, project) : new DevelopmentExecution(root, project.writablePaths, project.checkFiles);
}
