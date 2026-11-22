import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createStageWorkspace, hasWorkspaceRead } from '../src/mastra/stage-workspace.js';

/** 不同阶段只暴露各自的只读快照，且不提供执行和写入工具。 */
test('阶段 Workspace 隔离、只读和清理', async () => {
  const first = await createStageWorkspace('first', 'first', { 'src/a.txt': 'first' });
  const second = await createStageWorkspace('second', 'second', { 'src/a.txt': 'second' });
  try {
    assert.equal(await first.workspace.filesystem!.readFile('src/a.txt', { encoding: 'utf8' }), 'first');
    assert.equal(await second.workspace.filesystem!.readFile('src/a.txt', { encoding: 'utf8' }), 'second');
    assert.deepEqual(Object.keys(first.tools).sort(), ['mastra_workspace_file_stat', 'mastra_workspace_grep', 'mastra_workspace_list_files', 'mastra_workspace_read_file'].sort());
    await assert.rejects(first.workspace.filesystem!.writeFile('src/a.txt', 'changed'));
    await assert.rejects(first.workspace.filesystem!.readFile('../outside', { encoding: 'utf8' }));
  } finally { await first.close(); await second.close(); }
  await assert.rejects(first.workspace.filesystem!.readFile('src/a.txt', { encoding: 'utf8' }));
});

/** 失败、其他工具和伪造路径不能充当成功读取回执。 */
test('读取回执必须来自成功的 Workspace 读取', () => {
  assert.equal(hasWorkspaceRead([{ payload: { toolName: 'mastra_workspace_read_file', args: { path: 'a' }, result: 'ok' } }], 'a'), true);
  assert.equal(hasWorkspaceRead([{ payload: { toolName: 'mastra_workspace_read_file', args: { path: 'a' }, result: { error: 'failed' } } }], 'a'), false);
  assert.equal(hasWorkspaceRead([{ payload: { toolName: 'other', args: { path: 'a' }, result: 'ok' } }], 'a'), false);
});

/** 快照拒绝逃逸和隐藏路径。 */
test('阶段 Workspace 拒绝非法路径', async () => {
  await assert.rejects(createStageWorkspace('bad', 'bad', { '../escape': 'x' }));
  await assert.rejects(createStageWorkspace('bad', 'bad', { '.secret': 'x' }));
});
