import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { registerApiRoute, type ContextWithMastra } from '@mastra/core/server';
import { z } from 'zod';

const derive = promisify(scrypt);
const cookie = 'mastra_workbench_session';
const lifetimeSeconds = 8 * 60 * 60;
const username = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,63}$/);
const credentials = z.object({ username, password: z.string().min(12).max(128) }).strict();
const storedAccount = z.object({ username, salt: z.string().regex(/^[a-f0-9]{32}$/), hash: z.string().regex(/^[a-f0-9]{128}$/) });
type Account = z.infer<typeof storedAccount>;

/** 仅接收工作台回环页面发出的账号写请求。 */
function fromWorkbench(context: ContextWithMastra) {
  return context.req.header('origin') === 'http://127.0.0.1:4112';
}

/** 纠偏提交人取自短期会话，账号文件只保存密码派生值。 */
export function createWorkbenchAccount(databaseUrl: string) {
  const path = databaseUrl === 'file::memory:' ? undefined : `${fileURLToPath(databaseUrl)}.workbench-account.json`;
  let memoryAccount: Account | undefined;
  let authenticating = false;
  const sessions = new Map<string, { username: string; expires: number }>();

  /** 读取当前数据目录的唯一账号，缺失时允许首次设置。 */
  function readAccount() {
    if (!path) return memoryAccount;
    try { return storedAccount.parse(JSON.parse(readFileSync(path, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** 会话表只持有令牌摘要，浏览器 Cookie 只用于工作台接口。 */
  function sessionKey(context: ContextWithMastra) {
    const token = context.req.header('cookie')?.match(/(?:^|;\s*)mastra_workbench_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    return token ? createHash('sha256').update(token).digest('hex') : undefined;
  }

  /** 读取尚未过期的身份，不接受请求正文的用户名。 */
  function current(context: ContextWithMastra) {
    const key = sessionKey(context);
    const session = key && sessions.get(key);
    if (!session) return undefined;
    if (session.expires > Date.now()) return session.username;
    sessions.delete(key);
    return undefined;
  }

  /** 新会话替换当前浏览器的旧会话，退出时也在服务端撤销。 */
  function setSession(context: ContextWithMastra, name?: string) {
    const previous = sessionKey(context);
    if (previous) sessions.delete(previous);
    for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key);
    const token = name ? randomBytes(32).toString('hex') : '';
    if (name) sessions.set(createHash('sha256').update(token).digest('hex'), { username: name, expires: Date.now() + lifetimeSeconds * 1000 });
    context.header('Set-Cookie', `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/intake-api; Max-Age=${name ? lifetimeSeconds : 0}`);
  }

  /** 首次设置和登录均通过同一入口，账号创建使用独占写入。 */
  async function signIn(context: ContextWithMastra) {
    context.header('Cache-Control', 'no-store');
    if (!fromWorkbench(context)) return context.json({ error: '请从本机工作台登录。' }, 403);
    if (authenticating) return context.json({ error: '账号请求处理中，请稍后重试。' }, 429);
    authenticating = true;
    try {
      const input = credentials.safeParse(await context.req.json().catch(() => null));
      if (!input.success) return context.json({ error: '账号需为 2–64 位字母、数字、点、下划线或连字符，密码需为 12–128 位。' }, 400);
      const account = readAccount();
      const salt = account?.salt ?? randomBytes(16).toString('hex');
      const hash = await derive(input.data.password, salt, 64) as Buffer;
      if (account) {
        if (!timingSafeEqual(hash, Buffer.from(account.hash, 'hex')) || account.username !== input.data.username) return context.json({ error: '账号或密码不正确。' }, 401);
      } else {
        const created = { username: input.data.username, salt, hash: hash.toString('hex') };
        if (path) writeFileSync(path, JSON.stringify(created), { flag: 'wx', mode: 0o600 });
        else memoryAccount = created;
      }
      setSession(context, input.data.username);
      return context.json({ username: input.data.username, setupRequired: false });
    } catch {
      return context.json({ error: '账号暂不可用，请重试。' }, 503);
    } finally { authenticating = false; }
  }

  const routes = [
    registerApiRoute('/intake-api/account', { method: 'GET',
      /** 只返回登录状态和首次设置标记。 */
      handler: async context => {
        context.header('Cache-Control', 'no-store');
        try { return context.json({ username: current(context) ?? null, setupRequired: !readAccount() }); }
        catch { return context.json({ error: '账号暂不可用，请重试。' }, 503); }
      },
    }),
    registerApiRoute('/intake-api/account', { method: 'POST', handler: signIn }),
    registerApiRoute('/intake-api/account/logout', { method: 'POST',
      /** 退出只撤销当前浏览器的会话。 */
      handler: async context => {
        context.header('Cache-Control', 'no-store');
        if (!fromWorkbench(context)) return context.json({ error: '请从本机工作台退出。' }, 403);
        setSession(context);
        return context.json({ username: null, setupRequired: false });
      },
    }),
  ];
  return { current, routes };
}
