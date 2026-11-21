import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Hono, type Handler } from 'hono';
import { createWorkbenchAccount } from '../src/intake/workbench-account.js';

/** 隔离路由实例模拟热重启，验证会话只以摘要落盘且退出跨进程有效。 */
test('工作台账号会话跨重启保留，退出持久撤销', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'workbench-account-'));
  const databaseUrl = `file:${resolve(directory, 'workflow.db')}`;
  const origin = 'http://127.0.0.1:4112';
  /** 新建路由表示重建服务实例。 */
  function app() {
    const router = new Hono();
    for (const route of createWorkbenchAccount(databaseUrl).routes) if ('handler' in route) router.on(route.method, route.path, route.handler as Handler);
    return router;
  }
  try {
    let router = app();
    const login = await router.request('/intake-api/account', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'long-fixture-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const token = cookie.split('=')[1];
    const persisted = readFileSync(`${resolve(directory, 'workflow.db')}.workbench-account.json.sessions`, 'utf8');
    assert.ok(persisted.includes(createHash('sha256').update(token).digest('hex')));
    assert.ok(!persisted.includes(token));
    router = app();
    assert.equal((await (await router.request('/intake-api/account', { headers: { cookie } })).json()).username, 'tester');
    assert.equal((await router.request('/intake-api/account/logout', { method: 'POST', headers: { origin, cookie } })).status, 200);
    router = app();
    assert.equal((await (await router.request('/intake-api/account', { headers: { cookie } })).json()).username, null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
