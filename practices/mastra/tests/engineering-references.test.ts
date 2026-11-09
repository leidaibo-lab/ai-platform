/** 工程证据只从固定仓库读取，不让用户上传文档，也不执行项目脚本。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { readEngineeringReferences } from '../src/intake/engineering-references.js';

test('关联决策和归档文档、保留Git观察，不读.env或凭据文件，拒绝文档符号链接', /** 合成仓库origin使用允许地址，不访问远端或读取真实凭据。 */() => {
  const directory = realpathSync(mkdtempSync(resolve(tmpdir(), 'engineering-references-')));
  /** 所有Git参数为固定测试动作。 */
  function git(args: string[]) { return execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' }); }
  try {
    git(['init', '-q']); git(['remote', 'add', 'origin', 'https://github.com/leidaibo-lab/hrm.git']);
    mkdirSync(join(directory, 'docs/decisions'), { recursive: true });
    writeFileSync(join(directory, 'docs/decisions/test.md'), '# 合成工程决策'); writeFileSync(join(directory, 'docs/delivery-assets.md'), '# 合成资产规则');
    writeFileSync(join(directory, '.env'), 'SYNTHETIC_ONLY=must-not-read'); writeFileSync(join(directory, 'docs/decisions/credentials.md'), 'must-not-read');
    git(['add', 'docs']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    const result = readEngineeringReferences(directory);
    assert.equal(result.files['docs/decisions/test.md'], '# 合成工程决策'); assert.equal(result.files['docs/delivery-assets.md'], '# 合成资产规则'); assert.ok(result.files['engineering/repository-observation.json']);
    assert.doesNotMatch(JSON.stringify(result), /must-not-read|credentials\.md|\.env/); assert.match(result.note, /2份工程文档/);
    writeFileSync(join(directory, 'docs/delivery-assets.md'), '# 修改后的合成资产规则');
    const dirty = JSON.parse(readEngineeringReferences(directory).files['engineering/repository-observation.json']!);
    assert.deepEqual(dirty.sourceStatus, [' M docs/delivery-assets.md']);
    // 超过旧40份/500000字节门槛仍可关联，后续按需读取由Agent负责。
    for (let i = 0; i < 45; i++) writeFileSync(join(directory, `docs/decisions/extra-${i}.md`), '合成工程依据'.repeat(800));
    git(['add', 'docs/decisions']);
    const large = readEngineeringReferences(directory);
    assert.match(large.note, /47份工程文档/);
    assert.ok(Buffer.byteLength(JSON.stringify(large.files)) > 500000);
    symlinkSync(join(directory, 'docs/delivery-assets.md'), join(directory, 'docs/decisions/link.md')); git(['add', 'docs/decisions/link.md']);
    assert.throws(/** 不沿链接读取任何目标。 */() => readEngineeringReferences(directory), /符号链接/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
