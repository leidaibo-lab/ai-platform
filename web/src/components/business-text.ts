/** 仅识别完整匹配的纯文本结构，保留其余内容的原始排版。 */
export function parseBusinessText(text: string) {
  const groups = text.trim().split(/(?:\r?\n[ \t]*){2,}/).map(
    /** 空行划分分组，行首缩进不参与结构识别。 */
    group => group.split(/\r?\n/).map(line => line.trim()),
  );
  const transitions = groups.flatMap(([from, ...lines]) => lines.map(line => {
    const match = /^[├└]─\s*([^→]+?)\s*→\s*([^→]+)$/.exec(line);
    return match ? { from, action: match[1]!, to: match[2]! } : null;
  }));
  const titledGroups = groups.every(([title, ...lines]) => title && lines.length && !/^[*-]|[→├└]/.test(title));
  if (titledGroups && transitions.every(row => row !== null)) {
    return { kind: 'transitions' as const, rows: transitions };
  }
  if (titledGroups && groups.every(([, ...lines]) => lines.every(line => /^-\s+\S/.test(line)))) {
    return { kind: 'fields' as const, groups: groups.map(([title, ...lines]) => ({ title, fields: lines.map(line => line.replace(/^-\s+/, '')) })) };
  }
  const [first, ...rest] = groups[0] ?? [];
  if (groups.length === 1 && first && !first.includes('→') && rest.length && rest.every(line => /^→\s*[^→\s]/.test(line) && line.indexOf('→', 1) < 0)) {
    return { kind: 'steps' as const, steps: [first, ...rest.map(line => line.slice(1).trim())] };
  }
  return { kind: 'plain' as const, text };
}
