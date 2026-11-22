import { ChevronUp, Settings2, UserRound } from 'lucide-react';
import { useRef, useState } from 'react';

interface Props {
  username: string | null;
  settingsDisabled: boolean;
  openAccount: () => void;
  openSettings: () => void;
  openTeamSettings: () => void;
}

/** 侧栏底部的账号菜单支持鼠标悬停、触屏点击和键盘操作。 */
export function WorkbenchUserMenu({ username, settingsDisabled, openAccount, openSettings, openTeamSettings }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  /** 选择菜单项后关闭菜单并打开目标页面。 */
  function select(action: () => void) {
    setOpen(false);
    action();
  }

  return <div
    className="workbench-user"
    onPointerEnter={event => { if (event.pointerType === 'mouse') setOpen(true); }}
    onPointerLeave={event => {
      if (event.pointerType === 'mouse' && !panel.current?.contains(document.activeElement)) setOpen(false);
    }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => {
      if (!open || event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }}
  >
    <button
      ref={trigger}
      className="workbench-user-trigger"
      type="button"
      aria-expanded={open}
      aria-controls={open ? 'workbench-user-menu' : undefined}
      onClick={event => {
        if (event.detail === 0 || !window.matchMedia('(hover: hover)').matches) setOpen(!open);
        else setOpen(true);
      }}
    >
      <UserRound size={16} aria-hidden="true" />
      <span>{username ?? '登录'}</span>
      <ChevronUp size={14} aria-hidden="true" />
    </button>
    {open && <div ref={panel} className="workbench-user-menu" id="workbench-user-menu">
      <button type="button" onClick={() => select(openAccount)}>
        <UserRound size={15} aria-hidden="true" />{username ? '工作台账号' : '登录或设置账号'}
      </button>
      <button type="button" disabled={settingsDisabled} onClick={() => select(openTeamSettings)}><Settings2 size={15} aria-hidden="true" />团队配置</button>
      <button type="button" disabled={settingsDisabled} onClick={() => select(openSettings)}>
        <Settings2 size={15} aria-hidden="true" />业务工程接入
      </button>
    </div>}
  </div>;
}
