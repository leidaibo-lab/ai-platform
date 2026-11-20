import { useEffect, useRef, useState } from 'react';

interface AccountState {
  username: string | null;
  setupRequired: boolean;
}

/** 账号设置、登录和退出都使用浏览器的同源会话。 */
async function accountRequest(path = '', options: RequestInit = {}): Promise<AccountState> {
  const response = await fetch(`/intake-api/account${path}`, { ...options, signal: AbortSignal.timeout(10000) });
  if (response.status >= 500) throw new Error('账号暂不可用，请重试。');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '账号操作未完成。');
  return data;
}

/** 按需显示登录窗口，打开时重新查询账号与会话状态。 */
export function WorkbenchAccount({ open, signedIn, close }: { open: boolean; signedIn: (username: string | null) => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [account, setAccount] = useState<AccountState>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    if (open && !dialog.current?.open) dialog.current?.showModal();
    void accountRequest().then(next => {
      if (active) { setAccount(next); signedIn(next.username); }
    }).catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [open, signedIn]);

  /** 提交当前账号凭据，或撤销当前会话。 */
  async function update(fields?: FormData) {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const next = await accountRequest(fields ? '' : '/logout', {
        method: 'POST',
        ...(fields ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(fields)) } : {}),
      });
      signedIn(next.username);
      close();
    } catch (reason) { setError((reason as Error).message); }
    finally { setPending(false); }
  }

  if (!open) return null;
  const title = account?.username ? '工作台账号' : account?.setupRequired ? '设置工作台账号' : '登录工作台';
  return <dialog ref={dialog} className="workbench-account intake-card" aria-label={title} onCancel={event => { event.preventDefault(); if (!pending) close(); }}>
    <h2>{title}</h2>
    {error && <p role="alert">{error}</p>}
    {account?.username ? <><p>当前账号 {account.username}</p><button type="button" disabled={pending} onClick={() => void update()}>退出登录</button></> : account &&
      <form onSubmit={event => { event.preventDefault(); void update(new FormData(event.currentTarget)); }}>
        <label>账号<input name="username" autoComplete="username" required minLength={2} maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]{1,63}" /></label>
        <label>密码<input name="password" type="password" autoComplete={account.setupRequired ? 'new-password' : 'current-password'} required minLength={12} maxLength={128} /></label>
        {account.setupRequired && <small>账号使用字母或数字开头，密码至少 12 位。</small>}
        <div className="intake-actions"><button className="primary" disabled={pending}>{account.setupRequired ? '设置并登录' : '登录'}</button></div>
      </form>}
    <button type="button" disabled={pending} onClick={close}>关闭</button>
  </dialog>;
}
