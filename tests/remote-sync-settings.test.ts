/** 远端同步路由设置只允许服务端登记目标，阶段映射必须覆盖实际原生节点。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRemoteSyncSettings, readRemoteSyncTargets, resolveRemoteSyncTarget, syncPhaseForStep, writeRemoteSyncSettings, writeRemoteSyncTargets } from '../src/delivery/remote-sync-settings.js';

/** 构造仅用于设置存储的服务端目标注册表；不执行Git或网络操作。 */
function config(directory: string) {
  return { rootDir: directory, mode: 'fixture' as const, databaseUrl: `file:${join(directory, 'mastra.db')}`, port: 4111, modelId: 'openai/fixture' as const, remoteSyncTargets: [
    { id: 'hrm', label: 'HRM 项目仓库', root: '/workspace/hrm', origin: 'https://github.com/example/hrm.git' },
    { id: 'design-flow', label: '设计流程仓库', root: '/workspace/design-flow', origin: 'https://github.com/example/design-flow.git' },
  ] };
}

test('阶段映射覆盖当前完整产研流程，未知节点默认不产生远端写入', /** 避免新增节点意外落到错误仓库。 */() => {
  const expected = { 'review-product': 'product', architecture: 'architecture', implement: 'development', 'prepare-test-plan': 'testing', 'prepare-release-plan': 'release' } as const;
  for (const [step, phase] of Object.entries(expected)) assert.equal(syncPhaseForStep(step), phase);
  assert.equal(syncPhaseForStep('future-unclassified-step'), undefined);
});

test('阶段设置仅保存目标ID，并在运行时解析已登记仓库', /** 浏览器不拥有本地路径或Git远端的写入权。 */() => {
  const directory = mkdtempSync(join(tmpdir(), 'remote-sync-settings-'));
  try {
    const value = config(directory);
    const initial = readRemoteSyncSettings(value);
    assert.equal(initial.phases.product.targetId, 'hrm');
    const saved = writeRemoteSyncSettings(value, { ...initial, phases: { ...initial.phases, architecture: { enabled: true, targetId: 'design-flow' }, testing: { enabled: false, targetId: 'hrm' } } });
    assert.equal(saved.phases.architecture.targetId, 'design-flow');
    assert.equal(resolveRemoteSyncTarget(value, 'architecture')?.root, '/workspace/design-flow');
    assert.equal(resolveRemoteSyncTarget(value, 'prepare-test-plan'), undefined);
    assert.throws(/** 非服务端登记的ID不能绕过白名单。 */() => writeRemoteSyncSettings(value, { ...saved, phases: { ...saved.phases, release: { enabled: true, targetId: 'unknown' } } }), /已授权仓库/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('仓库字典保存前核验checkout，且不允许删除被启用阶段引用的目标', /** 字典管理不能把任意目录或失效目标带入执行路径。 */() => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'remote-sync-target-dictionary-')));
  const repository = join(directory, 'repository');
  try {
    execFileSync('git', ['init', repository], { stdio: 'ignore' });
    execFileSync('git', ['-C', repository, 'remote', 'add', 'origin', 'https://github.com/example/hrm.git'], { stdio: 'ignore' });
    const value = { ...config(directory), remoteSyncTargets: [{ id: 'hrm', label: 'HRM 项目仓库', root: repository, origin: 'https://github.com/example/hrm.git' }] };
    const saved = writeRemoteSyncTargets(value, { version: 'remote-sync-targets.v1', targets: [{ id: 'hrm', label: '招聘项目仓库', root: repository, origin: 'https://github.com/example/hrm.git' }] });
    assert.equal(saved[0].label, '招聘项目仓库'); assert.equal(readRemoteSyncTargets(value)[0].label, '招聘项目仓库');
    assert.throws(/** 当前产品阶段默认仍使用hrm，不能删除。 */() => writeRemoteSyncTargets(value, { version: 'remote-sync-targets.v1', targets: [{ id: 'other', label: '其他项目', root: repository, origin: 'https://github.com/example/hrm.git' }] }), /仍有阶段使用/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
