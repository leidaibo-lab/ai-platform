import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ShieldCheck } from 'lucide-react';

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
  return createPortal(<dialog ref={dialog} className="workbench-account" aria-labelledby="account-title" aria-describedby="account-description" onCancel={event => { event.preventDefault(); if (!pending) close(); }}>
    <header className="account-header">
      <span className="account-icon"><ShieldCheck size={20} aria-hidden="true" /></span>
      <button className="account-close" type="button" aria-label="关闭" disabled={pending} onClick={close}><X size={18} aria-hidden="true" /></button>
    </header>
    <h2 id="account-title">{title}</h2>
    <p id="account-description" className="account-description">{account?.username ? '管理当前工作台登录状态。' : account?.setupRequired ? '设置本机工作台账号，用于确认需要身份的操作。' : '登录后即可访问团队配置及需要身份的操作。'}</p>
    {error && <p className="account-error" role="alert">{error}</p>}
    {!account && !error && <p className="account-loading" role="status">正在读取账号状态…</p>}
    {account?.username ? <div className="account-signed-in"><span>当前账号</span><strong>{account.username}</strong><div className="account-actions"><button type="button" className="account-secondary" disabled={pending} onClick={close}>关闭</button><button type="button" className="account-primary" disabled={pending} onClick={() => void update()}>{pending ? '正在退出…' : '退出登录'}</button></div></div> : account &&
      <form className="account-form" onSubmit={event => { event.preventDefault(); void update(new FormData(event.currentTarget)); }}>
        <label htmlFor="account-username">账号</label><input id="account-username" name="username" autoComplete="username" spellCheck={false} required minLength={2} maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]{1,63}" autoFocus />
        <label htmlFor="account-password">密码</label><input id="account-password" name="password" type="password" autoComplete={account.setupRequired ? 'new-password' : 'current-password'} required minLength={12} maxLength={128} aria-describedby={account.setupRequired ? 'account-hint' : undefined} />
        {account.setupRequired && <small id="account-hint">账号以字母或数字开头，可包含点、下划线或连字符；密码至少 12 位。</small>}
        <div className="account-actions"><button className="account-secondary" type="button" disabled={pending} onClick={close}>取消</button><button className="account-primary" type="submit" disabled={pending}>{pending ? '正在处理…' : account.setupRequired ? '设置并登录' : '登录'}</button></div>
      </form>}
  </dialog>, document.body);
}
