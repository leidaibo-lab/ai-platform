import { defaultComponents, type Components } from 'streamdown';
import { parseBusinessText } from './business-text';

/** 将业务文档的 text 围栏呈现为可读结构，其他围栏沿用代码组件。 */
export const BusinessTextBlock: NonNullable<Exclude<Components['pre'], string>> = props => {
  const code = props.node?.children[0];
  const classes = code?.type === 'element' ? code.properties.className : undefined;
  const value = code?.type === 'element' && code.children.length === 1 ? code.children[0] : undefined;
  if (!Array.isArray(classes) || !classes.includes('language-text') || value?.type !== 'text') {
    const DefaultPre = defaultComponents.pre;
    return <DefaultPre {...props} />;
  }
  const content = parseBusinessText(value.value);
  switch (content.kind) {
    case 'transitions':
      return <div className="business-text business-transitions"><table aria-label="状态流转">
        <thead><tr><th scope="col">当前状态</th><th scope="col">操作或结果</th><th scope="col">后续状态</th></tr></thead>
        <tbody>{content.rows.map(({ from, action, to }, index) => <tr key={index}><td>{from}</td><td>{action}</td><td>{to}</td></tr>)}</tbody>
      </table></div>;
    case 'fields':
      return <div className="business-text business-fields">{content.groups.map(({ title, fields }, index) => <div key={index}>
        <strong>{title}</strong>
        <ul>{fields.map((field, fieldIndex) => <li key={fieldIndex}>{field}</li>)}</ul>
      </div>)}</div>;
    case 'steps':
      return <div className="business-text"><ol className="business-steps">{content.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></div>;
    case 'plain':
      return <div className="business-text business-plain">{content.text}</div>;
  }
};
