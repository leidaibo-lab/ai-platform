import { createHash } from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import { parse } from '@babel/parser';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import ts from 'typescript-language-service';
import { developmentHash } from '../contracts.js';
import type { ExecutionPort } from './execution-scope.js';
import type { StateV2 } from './contracts.js';

/** 在当前执行作用域中读取候选，使用前后快照拒绝并发漂移。 */
async function candidate(execution: ExecutionPort, path: string) {
  const before = await execution.snapshot();
  const exists = Object.hasOwn(before, path);
  const content = exists ? await execution.readFile(path) : undefined;
  const after = await execution.snapshot();
  if (developmentHash(before) !== developmentHash(after)) throw new Error('候选读取期间发生变化');
  return { content, hash: developmentHash(after), fileHash: before[path] ?? null };
}

/** 依据当前状态输入基线和隔离执行环境装配只读查询。 */
export function createCandidateQueryTools(execution: ExecutionPort, state: StateV2) {
  return {
    candidateChanges: createTool({ id: 'development-candidate-changes', description: '列出本Run输入基线相对当前隔离候选的变更文件及散列；可分页', inputSchema: z.object({ cursor: z.number().int().nonnegative().default(0), candidateHash: z.string().length(64).optional() }).strict(),
      /** 比较基线和候选散列，续页必须绑定同一候选身份。 */
      execute: async ({ cursor, candidateHash }) => {
        const snapshot = await execution.snapshot(); const hash = developmentHash(snapshot);
        if ((cursor > 0 && !candidateHash) || (candidateHash && candidateHash !== hash)) throw new Error('候选分页身份缺失或漂移');
        const baseline = state.input.project.files;
        const paths = [...new Set([...Object.keys(snapshot), ...Object.keys(baseline)])].sort();
        const changes = paths.flatMap(path => {
          const oldHash = Object.hasOwn(baseline, path) ? createHash('sha256').update(baseline[path]).digest('hex') : null;
          const newHash = Object.hasOwn(snapshot, path) ? snapshot[path] : null;
          return oldHash === newHash ? [] : [{ path, status: oldHash === null ? 'added' : newHash === null ? 'deleted' : 'modified', baselineHash: oldHash, fileHash: newHash }];
        });
        if (cursor > changes.length) throw new Error('变更目录位置越界');
        return { projectId: state.input.project.id, candidateHash: hash, changes: changes.slice(cursor, cursor + 50), nextCursor: cursor + 50 < changes.length ? cursor + 50 : null };
      },
    }),
    candidateDiff: createTool({ id: 'development-candidate-diff', description: '查看当前候选文件相对本Run输入基线的统一diff；按字符分页', inputSchema: z.object({ path: z.string().min(1), offset: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(6000).default(3000), candidateHash: z.string().length(64).optional() }).strict(),
      /** 按精确快照路径比较，保留文件新增和删除。 */
      execute: async ({ path, offset, length, candidateHash }) => {
        const current = await candidate(execution, path);
        if ((offset > 0 && !candidateHash) || (candidateHash && candidateHash !== current.hash)) throw new Error('候选分页身份缺失或漂移');
        const old = Object.hasOwn(state.input.project.files, path) ? state.input.project.files[path] : undefined;
        if (old === undefined && current.content === undefined) throw new Error('未知候选文件');
        const patch = old === current.content ? '' : createTwoFilesPatch(old === undefined ? '/dev/null' : path, current.content === undefined ? '/dev/null' : path, old ?? '', current.content ?? '', '', '', { context: 3 });
        if (offset > patch.length) throw new Error('变更位置越界');
        const content = patch.slice(offset, offset + length);
        return { projectId: state.input.project.id, path, baselineHash: old === undefined ? null : createHash('sha256').update(old).digest('hex'), candidateHash: current.hash, fileHash: current.fileHash, changed: old !== current.content, offset, content, nextOffset: offset + content.length < patch.length ? offset + content.length : null };
      },
    }),
    codeReferences: createTool({ id: 'development-code-references', description: '按行列查询候选内JS/TS符号的语义引用；仅索引当前快照，不读取外部依赖', inputSchema: z.object({ path: z.string().min(1), line: z.number().int().positive(), column: z.number().int().positive(), cursor: z.number().int().nonnegative().default(0) }).strict(),
      /** 构建内存语言服务，限定候选文件并在读取后复核快照。 */
      execute: async ({ path, line, column, cursor }) => {
        const before = await execution.snapshot();
        const paths = Object.keys(before).filter(file => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)).sort();
        if (!paths.includes(path)) throw new Error('未知或不支持的候选文件');
        if (paths.length > 200) throw new Error('候选代码文件超过查询上限');
        const files = new Map<string, string>(); let bytes = 0;
        for (const file of paths) { const text = await execution.readFile(file); bytes += Buffer.byteLength(text); if (bytes > 2000000) throw new Error('候选代码超过查询上限'); files.set(`/candidate/${file}`, text); }
        if (developmentHash(before) !== developmentHash(await execution.snapshot())) throw new Error('候选读取期间发生变化');
        const fileName = `/candidate/${path}`; const text = files.get(fileName)!;
        const lineStart = text.split('\n');
        if (line > lineStart.length || column > lineStart[line - 1].length + 1) throw new Error('代码位置越界');
        const position = lineStart.slice(0, line - 1).reduce((sum, value) => sum + value.length + 1, 0) + column - 1;
        const host: ts.LanguageServiceHost = {
          getScriptFileNames: () => [...files.keys()], getScriptVersion: () => '1',
          getScriptSnapshot: file => { const content = files.get(file); return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content); },
          getCurrentDirectory: () => '/candidate', getCompilationSettings: () => ({ allowJs: true, noLib: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Node10, jsx: ts.JsxEmit.Preserve, allowNonTsExtensions: true }),
          getDefaultLibFileName: () => '/candidate/__not_loaded__.d.ts', fileExists: file => files.has(file), readFile: file => files.get(file),
          directoryExists: dir => [...files.keys()].some(file => file.startsWith(dir.replace(/\/$/, '') + '/')), getDirectories: () => [],
        };
        const service = ts.createLanguageService(host);
        try {
          const refs = service.getReferencesAtPosition(fileName, position) ?? [];
          const matches = refs.flatMap(ref => {
            const content = files.get(ref.fileName); if (content === undefined) return [];
            const source = ts.createSourceFile(ref.fileName, content, ts.ScriptTarget.Latest);
            const loc = source.getLineAndCharacterOfPosition(ref.textSpan.start);
            return [{ path: ref.fileName.slice('/candidate/'.length), line: loc.line + 1, column: loc.character + 1, length: ref.textSpan.length, isWrite: ref.isWriteAccess }];
          });
          if (cursor > matches.length) throw new Error('查询位置越界');
          return { projectId: state.input.project.id, candidateHash: developmentHash(before), language: 'JavaScript/TypeScript', parserVersion: ts.version, scope: '仅当前候选 JS/TS 文件；未加载依赖、标准库、项目编译配置或其他语言，结果可能不完整', matches: matches.slice(cursor, cursor + 50), nextCursor: cursor + 50 < matches.length ? cursor + 50 : null };
        } finally { service.dispose(); }
      },
    }),
    codeStructure: createTool({ id: 'development-code-structure', description: '查询单个JS/TS候选文件的语法声明与标识符位置；同名匹配不代表语义引用', inputSchema: z.object({ path: z.string().min(1), identifier: z.string().min(1).max(200).optional(), cursor: z.number().int().nonnegative().default(0) }).strict(),
      /** 基于语法树列出声明或标识符，避免将词法匹配误报为语义引用。 */
      execute: async ({ path, identifier, cursor }) => {
        if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) throw new Error('仅支持 JavaScript 和 TypeScript 文件');
        const current = await candidate(execution, path);
        if (current.content === undefined) throw new Error('未知候选文件');
        const ast = parse(current.content, { sourceType: 'unambiguous', plugins: [...(/\.[cm]?tsx?$/.test(path) ? ['typescript' as const] : []), ...(/\.[jt]sx$/.test(path) ? ['jsx' as const] : [])] });
        const matches: { name: string; kind: string; line: number; column: number }[] = [];
        /** 仅遍历 AST 节点，跳过位置与元数据以避免重复计数。 */
        function visit(value: unknown, parentKind = ''): void {
          if (!value || typeof value !== 'object') return;
          if (Array.isArray(value)) { for (const child of value) visit(child, parentKind); return; }
          const node = value as Record<string, any>;
          if (typeof node.type !== 'string') return;
          const isDeclaration = /(?:Declaration|Method)$/.test(node.type);
          if (node.loc && ((identifier && node.type === 'Identifier' && node.name === identifier) || (!identifier && isDeclaration))) matches.push({ name: identifier ?? node.id?.name ?? node.key?.name ?? '(匿名)', kind: identifier ? parentKind : node.type, line: node.loc.start.line, column: node.loc.start.column + 1 });
          for (const [key, child] of Object.entries(node)) if (!['loc', 'start', 'end', 'comments', 'tokens', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)) visit(child, node.type);
        }
        visit(ast.program);
        if (cursor > matches.length) throw new Error('查询位置越界');
        return { projectId: state.input.project.id, path, candidateHash: current.hash, fileHash: current.fileHash, scope: '单文件语法查询；同名标识符不保证语义绑定，跨文件引用未解析', matches: matches.slice(cursor, cursor + 50), nextCursor: cursor + 50 < matches.length ? cursor + 50 : null };
      },
    }),
  };
}
