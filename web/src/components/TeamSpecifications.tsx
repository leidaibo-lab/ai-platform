import type { Team } from './run-flow-state';

export interface Specification {
  kind: 'requirements' | 'product' | 'development' | 'testing';
  branch: string;
  commit: string;
  files: { path: string; link?: { href: string; fixedVersion: boolean } }[];
}

const owners: Record<Specification['kind'], Team> = { requirements: 'product', product: 'product', development: 'development', testing: 'testing' };
const fileTitles: Record<string, string> = {
  'specs/requirements.md': '需求文档',
  'specs/product-spec.md': '产品规格',
  'specs/development-spec.md': '技术规格',
  'specs/test-spec.md': '测试规格',
};

/** 在归属团队展示正式规格回执中的文件和固定提交。 */
export function TeamSpecifications({ team, specifications }: { team: Team; specifications: Specification[] }) {
  const published = specifications.filter(/** 按产物职责归属团队。 */item => owners[item.kind] === team);
  if (!published.length) return null;
  return <section className="intake-card" aria-label="已发布的正式规格">
    <h2>已发布的正式规格</h2>
    {published.map(/** 分支和提交直接回显原生回执。 */item => <div key={item.kind}>
      <p><code>{item.branch}</code> · <code title={item.commit}>{item.commit.slice(0, 12)}</code></p>
      <ul>{item.files.map(/** 文件链接使用固定版本，未知平台提供仓库入口。 */({ path, link }) => <li key={path}>
        {link?.fixedVersion ? <a href={link.href} target="_blank" rel="noreferrer">{fileTitles[path] ?? path} · <code>{path}</code></a>
          : <>{fileTitles[path] ?? path} · <code>{path}</code>{link && <> · <a href={link.href} target="_blank" rel="noreferrer">查看仓库</a></>}</>}
      </li>)}</ul>
    </div>)}
  </section>;
}
