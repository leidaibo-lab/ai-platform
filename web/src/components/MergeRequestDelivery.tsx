import { useState } from 'react';

export interface MergeRequestDeliveryReceipt {
  number: number;
  url: string;
  branch: string;
  commit: string;
  base: string;
}

/** 只使用已核验回执中的仓库、源分支和固定提交生成本地检出命令。 */
function checkoutCommands(receipt: MergeRequestDeliveryReceipt): string | undefined {
  const repository = /^https:\/\/github\.com\/([a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+)\/pull\/[1-9][0-9]*$/.exec(receipt.url)?.[1];
  if (!repository || !/^run\/[a-z0-9-]+$/.test(receipt.branch) || !/^[a-f0-9]{40,64}$/.test(receipt.commit)) return undefined;
  return [
    `git fetch --no-tags 'https://github.com/${repository}.git' 'refs/heads/${receipt.branch}' &&`,
    `git worktree add --detach '../qa-${receipt.commit.slice(0, 12)}' '${receipt.commit}'`,
  ].join('\n');
}

/** 从交付回执展示可在业务仓库本地验证的固定版本。 */
export function MergeRequestDelivery({ receipt }: { receipt: MergeRequestDeliveryReceipt }) {
  const [notice, setNotice] = useState('');
  const commands = checkoutCommands(receipt);

  /** 复制失败时保留可手动选取的命令。 */
  async function copyCommands() {
    if (!commands) return;
    try {
      await navigator.clipboard.writeText(commands);
      setNotice('已复制检出命令。');
    } catch {
      setNotice('无法访问剪贴板，请手动复制下方命令。');
    }
  }

  return <section className="intake-card">
    <h2>MR 已提交</h2>
    <p>源分支 <code>{receipt.branch}</code><br />目标分支 <code>{receipt.base}</code><br />候选提交 <code>{receipt.commit}</code></p>
    <a href={receipt.url} target="_blank" rel="noreferrer">查看 MR #{receipt.number}</a>
    {commands && <details open>
      <summary>本地验证</summary>
      <p>在本地业务仓库中运行以下命令。Git 会在相邻目录检出 QA 放行的固定提交，供你启动项目并复跑用例。</p>
      <pre className="delivery-checkout-command"><code>{commands}</code></pre>
      <button type="button" onClick={copyCommands}>复制检出命令</button>
      {notice && <p role="status">{notice}</p>}
    </details>}
  </section>;
}
