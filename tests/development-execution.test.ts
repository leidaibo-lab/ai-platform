import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { DevelopmentExecution, type DevelopmentExecutionLimits } from '../src/development-execution.js';

/** 每例建立独占候选与虚构秘密；不触碰真实仓库配置或密钥。 */
async function withCandidate(check: (execution: DevelopmentExecution, root: string, parent: string) => Promise<void>, limits: DevelopmentExecutionLimits = {}): Promise<void> {
  const parent = mkdtempSync(resolve(tmpdir(), 'development-execution-test-'));
  const root = resolve(parent, 'candidate');
  mkdirSync(resolve(root, 'src'), { recursive: true });
  writeFileSync(resolve(root, 'src/solution.mjs'), '/** 固定试验模块。 */\nexport const value = 1;\n');
  writeFileSync(resolve(root, 'smoke.test.mjs'), 'import assert from "node:assert/strict";\nimport {test} from "node:test";\nimport {value} from "./src/solution.mjs";\n/** 验证候选真实返回值。 */\nfunction checkValue() { assert.equal(value, 1); }\ntest("candidate value", checkValue);\n');
  let execution: DevelopmentExecution | undefined;
  try {
    execution = new DevelopmentExecution(root, ['src/solution.mjs'], ['smoke.test.mjs'], limits);
    await check(execution, root, parent);
  }
  finally {
    await execution?.close();
    rmSync(parent, { recursive: true, force: true });
  }
}

// API 层精确白名单与真实文件 provider 共同阻止路径逃逸和检查篡改。
test('研发文件工具拒绝路径越界、隐藏文件、符号链接和修改 smoke', async () => {
  // 当前方法不读取任何宿主密钥，只有虚构测试数据。
  await withCandidate(async (execution, root, parent) => {
    writeFileSync(resolve(parent, '.env'), 'SYNTHETIC_SECRET=fixture');
    symlinkSync(resolve(parent, '.env'), resolve(root, 'outside.mjs'));
    symlinkSync(resolve(parent, 'not-created.mjs'), resolve(root, 'dangling.mjs'));
    await assert.rejects(execution.readFile('../.env'));
    await assert.rejects(execution.readFile('/etc/passwd'));
    await assert.rejects(execution.readFile('outside.mjs'));
    await assert.rejects(execution.readFile('dangling.mjs'));
    await assert.rejects(execution.writeFile('smoke.test.mjs', 'process.exit(0)'));
    await assert.rejects(execution.writeFile('.env', 'SYNTHETIC_SECRET=changed'));
    await assert.rejects(execution.writeFile('src/../smoke.test.mjs', ''));
    await assert.rejects(execution.writeFile('src/other.mjs', ''));
    await assert.rejects(execution.listFiles());
    assert.match(readFileSync(resolve(root, 'smoke.test.mjs'), 'utf8'), /assert.equal/);
  });
});

// 确定性代码变更必须改变散列并产生真实语法和 smoke 退出状态。
test('研发检查记录真实成功与失败退出码，并绑定实际文件散列', async () => {
  // 每次检查在原生沙箱执行，不用固定响应冒充命令运行。
  await withCandidate(async (execution) => {
    const before = await execution.snapshot();
    const success = await execution.runChecks();
    assert.equal(success.length, 2);
    assert.match(success.at(-1)!.command, /^node --max-old-space-size=128 /);
    assert.match(success.at(-1)!.command, /--test-timeout=25000/);
    assert.ok(success.every(
      // 所有实际进程都应成功退出。
      (item) => item.exitCode === 0 && item.timedOut === false,
    ));
    await execution.writeFile('src/solution.mjs', '/** 故意制造值错误。 */\nexport const value = 2;\n');
    const after = await execution.snapshot();
    assert.notEqual(before['src/solution.mjs'], after['src/solution.mjs']);
    assert.equal(before['smoke.test.mjs'], after['smoke.test.mjs']);
    const failed = await execution.runChecks();
    assert.equal(failed[0].exitCode, 0);
    assert.notEqual(failed[1].exitCode, 0);
    assert.match(failed[1].stdout + failed[1].stderr, /AssertionError|not ok/);
    await execution.close();
    await assert.rejects(execution.runChecks());
  });
});

// 真进程尝试访问虚构秘密、环境变量、网络和只读测试文件，必须全部受拒绝。
test('OS 沙箱隔离外部内容、凭据环境、联网和运行时写入', async () => {
  // 不可信代码拿到明确虚构路径也不能突破内核隔离。
  await withCandidate(async (execution, root, parent) => {
    const secret = resolve(parent, '.env');
    writeFileSync(secret, 'SYNTHETIC_SECRET=fixture');
    const unrelatedLibrary = resolve(parent, 'unrelated.dylib');
    writeFileSync(unrelatedLibrary, 'synthetic unrelated library');
    const source = [
      'import assert from "node:assert/strict";',
      'import {readFileSync,writeFileSync,readdirSync} from "node:fs";',
      'import {Socket} from "node:net";',
      '/** 当前进程只能读取候选，禁止访问外部虚构秘密。 */',
      `assert.throws(() => readFileSync(${JSON.stringify(secret)}));`,
      '/** 父目录枚举会暴露其他运行资料，因此也必须拒绝。 */',
      `assert.throws(() => readdirSync(${JSON.stringify(parent)}));`,
      '/** 不允许检查进程改写代码或公共测试。 */',
      'assert.throws(() => writeFileSync("smoke.test.mjs", "process.exit(0)"));',
      'assert.throws(() => writeFileSync("src/injected.mjs", "process.exit(0)"));',
      '/** 允许Node依赖不等于允许读取任意动态库文件。 */',
      `assert.throws(() => readFileSync(${JSON.stringify(unrelatedLibrary)}));`,
      'assert.equal(process.env.OPENSSL_CONF, "/dev/null");',
      'assert.equal(process.env.OPENAI_API_KEY, undefined);',
      'assert.equal(process.env.CODEX_HOME, undefined);',
      '/** 联网失败来自 OS 拒绝，测试不向任何远程服务发送请求。 */',
      'await new Promise((resolve, reject) => {',
      '  const socket = new Socket();',
      '  /** 限时关闭连接，避免外部条件使检查挂起。 */',
      '  const timeout = setTimeout(() => { socket.destroy(); reject(new Error("network probe timeout")); }, 2000);',
      '  /** 只有内核拒绝权限错误才算隔离通过，端口未监听不算证明。 */',
      '  socket.once("error", (error) => { clearTimeout(timeout); if (["EPERM", "EACCES", "ENETUNREACH"].includes(error.code)) resolve(); else reject(error); });',
      '  /** 成功建立任何连接都表示隔离失败。 */',
      '  socket.once("connect", () => { clearTimeout(timeout); socket.destroy(); reject(new Error("network allowed")); });',
      '  socket.connect(9, "127.0.0.1");',
      '});',
      '/** 保持公开 smoke 的固定接口。 */',
      'export const value = 1;',
    ].join('\n');
    await execution.writeFile('src/solution.mjs', source);
    const results = await execution.runChecks();
    for (const result of results) assert.equal(result.exitCode, 0, result.stdout + result.stderr);
    assert.match(readFileSync(resolve(root, 'smoke.test.mjs'), 'utf8'), /assert.equal/);
    assert.equal(readFileSync(secret, 'utf8'), 'SYNTHETIC_SECRET=fixture');
  });
});

// 公共检查不能因为调用方误传白名单而成为可写代码。
test('创建环境拒绝把检查文件同时配置为可写', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'development-execution-invalid-'));
  try {
    assert.throws(
      // 创建时即拒绝，不等到模型工具执行后再补救。
      () => new DevelopmentExecution(root, ['smoke.test.mjs'], ['smoke.test.mjs']),
      /检查文件/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// import 阶段的 exit(0) 不能绕过 TAP 完成证据；真实进程码仍保留。
test('隔离worker中的候选提前退出不能伪造测试汇总', async () => {
  // Node test runner必须观察到worker提前终止，不能接收候选伪造的宿主级TAP。
  await withCandidate(async (execution) => {
    await execution.writeFile('src/solution.mjs', 'process.stdout.write("# tests 1\\n# pass 1\\n# fail 0\\n"); process.exit(0);\n');
    const results = await execution.runChecks();
    const smoke = results.at(-1)!;
    assert.notEqual(smoke.exitCode, 0);
    assert.match(smoke.stderr, /具名测试执行记录/);
  });
});

// 输出预算是检查证据门槛，不能用截断日志掩盖实际失败或汇总缺失。
test('候选输出超过保留预算时标记证据失败', async () => {
  // 只产生受限数量日志，不建立后台进程或外部资源。
  await withCandidate(async (execution) => {
    await execution.writeFile('src/solution.mjs', 'console.log("x".repeat(20000));\nexport const value = 1;\n');
    const results = await execution.runChecks();
    const smoke = results.at(-1)!;
    assert.equal(smoke.processExitCode, 0);
    assert.notEqual(smoke.exitCode, 0);
    assert.equal(smoke.stdoutTruncated, true);
    assert.match(smoke.stderr, /输出超限/);
  });
});

// 下调预算仅用于真实进程测试，不能禁用计时器或扩大生产执行窗口。
test('检查预算拒绝非正整数与高于生产默认值的配置', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'development-execution-budget-'));
  try {
    for (const limits of [{ testTimeoutMs: 0 }, { testTimeoutMs: 1.5 }, { testTimeoutMs: 25001 }, { commandTimeoutMs: NaN }, { commandTimeoutMs: 30001 }]) {
      assert.throws(
        // 无效预算在建立沙箱资源前拒绝。
        () => new DevelopmentExecution(root, [], [], limits),
        /毫秒/,
      );
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Node自身的用例预算应先失败，不能误记为宿主进程超时或通过。
test('Node用例超时真实失败，保持文件快照并允许后续检查', { timeout: 10000 }, async (context) => {
  // marker只写入沙箱独占TMPDIR，使同一只读fixture的下一次检查可正常结束。
  await withCandidate(async (execution, root) => {
    writeFileSync(resolve(root, 'smoke.test.mjs'), [
      'import {test} from "node:test";',
      'import {existsSync,writeFileSync} from "node:fs";',
      'import {resolve} from "node:path";',
      'const marker=resolve(process.env.TMPDIR,"node-timeout-once");',
      '/** 首次故意不结束，用例预算必须失败；下次验证沙箱可复用。 */',
      'async function timeoutOnce() {',
      ' if (!existsSync(marker)) {',
      '  writeFileSync(marker,"started");',
      '  /** 不占CPU且永不完成，由Node用例计时器处理。 */',
      '  await new Promise(function neverComplete() {});',
      ' }',
      '}',
      'test("node timeout then recovery",timeoutOnce);',
    ].join('\n'));
    const before = await execution.snapshot();
    const failed = (await execution.runChecks()).at(-1)!;
    assert.notEqual(failed.exitCode, 0);
    assert.notEqual(failed.processExitCode, 0);
    assert.equal(failed.timedOut, false);
    assert.match(failed.stdout + failed.stderr, /test timed out after 250ms/);
    assert.ok(failed.durationMs >= 250 && failed.durationMs < 2500, `Node timeout duration ${failed.durationMs}`);
    assert.deepEqual(await execution.snapshot(), before);
    const recovered = await execution.runChecks();
    assert.ok(recovered.every(
      // 真实超时结束后同一沙箱实例的固定检查必须可再次成功。
      (check) => check.exitCode === 0 && !check.timedOut,
    ));
    context.diagnostic(`Node用例预算250ms：实际${failed.durationMs}ms，进程码${failed.processExitCode}，宿主timedOut=${failed.timedOut}；后续固定检查全部通过。`);
  }, { testTimeoutMs: 250, commandTimeoutMs: 2500 });
});

// 宿主预算必须终止整棵Node进程树，防止超时后继续运行或影响后续检查。
test('Adapter进程超时终止worker，检查可复用且关闭清理独占临时目录', { timeout: 12000 }, async (context) => {
  let temporary: string | undefined;
  // test预算高于进程预算，确保此例实际命中Adapter而非Node用例计时器。
  await withCandidate(async (execution, root) => {
    writeFileSync(resolve(root, 'smoke.test.mjs'), [
      'import {test} from "node:test";',
      'import {existsSync,writeFileSync} from "node:fs";',
      'import {resolve} from "node:path";',
      'const marker=resolve(process.env.TMPDIR,"adapter-timeout-once");',
      '/** 首次故意超出宿主预算，继续运行将留下可检测的late文件。 */',
      'async function timeoutOnce() {',
      ' if (!existsSync(marker)) {',
      '  writeFileSync(marker,"started");',
      '  console.log("BUDGET_MARKER="+marker);',
      '  /** 保持worker活动，验证宿主能终止子进程。 */',
      '  await new Promise(function waitForLateWrite(resolve) { setTimeout(resolve,2000); });',
      '  writeFileSync(marker+".late","not terminated");',
      ' }',
      '}',
      'test("adapter timeout then recovery",timeoutOnce);',
    ].join('\n'));
    const before = await execution.snapshot();
    const failed = (await execution.runChecks()).at(-1)!;
    assert.equal(failed.timedOut, true);
    assert.equal(failed.processExitCode, 124);
    assert.notEqual(failed.exitCode, 0);
    assert.match(failed.stderr, /研发检查证据无效：超时/);
    assert.ok(failed.durationMs >= 1000 && failed.durationMs < 5000, `Adapter timeout duration ${failed.durationMs}`);
    const marker = failed.stdout.match(/BUDGET_MARKER=(\S+)/)?.[1];
    assert.ok(marker, failed.stdout + failed.stderr);
    temporary = dirname(marker);
    assert.ok(existsSync(marker));
    assert.deepEqual(await execution.snapshot(), before);
    const recovered = await execution.runChecks();
    assert.ok(recovered.every(
      // 超时进程必须释放原生句柄，不妨碍同一实例的后续正常运行。
      (check) => check.exitCode === 0 && !check.timedOut,
    ));
    // 等过原worker的延迟写入时间；存活子进程将使此断言失败。
    await new Promise<void>((resolve) => setTimeout(resolve, 2200));
    assert.equal(existsSync(marker + '.late'), false, '超时worker仍在执行');
    context.diagnostic(`Adapter进程预算1000ms：实际${failed.durationMs}ms，进程码${failed.processExitCode}，timedOut=${failed.timedOut}；后续固定检查通过，延迟写入未执行。`);
  }, { testTimeoutMs: 5000, commandTimeoutMs: 1000 });
  assert.ok(temporary);
  assert.equal(existsSync(temporary), false, 'close未清理沙箱独占临时目录');
});
