import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

for (const independent of [false, true]) test(`平台修复跨进程接续，重复事件只执行一次并保留方案审批：${independent ? '独立研发' : '主流程'}`, async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'mastra-platform-repair-'));
  const runId = randomUUID();
  /** 每次请求从独立进程重新打开同一原生 Store。 */
  async function processRequest(command: string, event?: object) {
    const { stdout } = await execute(process.execPath, ['--import', 'tsx', 'tests/fixtures/platform-repair-process.ts', directory, runId, command, event ? JSON.stringify(event) : '', independent ? 'independent' : 'mainline']);
    return JSON.parse(stdout.trim().split('\n').at(-1)!);
  }
  try {
    const repository = resolve(directory, 'repository');
    const remote = resolve(directory, 'remote.git');
    await Promise.all([execute('git', ['init', '-b', 'main', repository]), execute('git', ['init', '--bare', remote])]);
    await execute('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'test(platform): 初始化合成远端']);
    await execute('git', ['-C', repository, 'remote', 'add', 'origin', remote]);
    await execute('git', ['-C', repository, 'push', 'origin', 'main']);
    const start = await processRequest('start');
    assert.equal(start.status, 'suspended');
    assert.equal(start.gate, undefined);
    assert.equal(start.awaitingPlatform, true);
    assert.equal(start.waiting.dependency, 'model-service');
    const event = { faultId: start.waiting.faultId, checkpoint: start.waiting.checkpoint, eventId: randomUUID() };
    const [unauthorized, stale] = await Promise.all([processRequest('unauthorized', event), processRequest('notify', { ...event, checkpoint: '0'.repeat(64) })]);
    assert.equal(unauthorized.http, 401);
    assert.equal(stale.http, 409);
    writeFileSync(resolve(directory, 'repaired'), 'synthetic repaired');
    const responses = await Promise.all([processRequest('notify', event), processRequest('notify', { ...event, eventId: randomUUID() })]);
    assert.ok(responses.every(item => ['accepted', 'duplicate', 'processing'].includes(item.status)), JSON.stringify(responses));
    assert.equal(responses.filter(item => item.status === 'accepted').length, 1);
    assert.deepEqual(await processRequest('notify', event), { http: 200, status: 'duplicate' });
    const after = await processRequest('inspect');
    assert.equal(after.status, 'suspended');
    assert.equal(after.gate, 'approve-architecture');
    assert.equal(after.recovery.used, 1);
    assert.equal(after.recovery.attempts[0].action, 'platform-repair');
    assert.equal(after.recovery.attempts[0].result, 'execution-passed');
    assert.equal(after.metrics.platformEvents, 1);
    assert.equal(after.metrics.humanTechnicalDecisions, 0);
    assert.equal(after.metrics.architectureApprovals, 0);
    assert.equal(readFileSync(resolve(directory, 'side-effect'), 'utf8'), 'architecture\n');
    const ref = `refs/heads/codex/workflow/${runId}`;
    const { stdout: commit } = await execute('git', ['--git-dir', remote, 'rev-parse', ref]);
    const replay = await processRequest('recheck-git');
    assert.equal(replay.commit, commit.trim());
    const count = await execute('git', ['--git-dir', remote, 'rev-list', '--count', 'main..' + ref]);
    assert.equal(count.stdout.trim(), '1');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
