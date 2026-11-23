import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createStudioApplicationOptions } from '../src/mastra/app.js';

// 三个 Studio 角色不依赖 Run，并且不能通过工具访问项目。
test('Studio 独立研发角色可对话且没有项目工具', async () => {
  const app = createStudioApplicationOptions({ rootDir: resolve('.'), mode: 'fixture', modelId: 'openai/fixture', port: 4111, databaseUrl: 'file::memory:' });
  const cases = [
    [app.agents.developmentLeadAgent, ['development-architecture-document', 'development-bmad-task-handoff', 'development-gstack-engineering-review']],
    [app.agents.developmentImplementerAgent, ['development-implementation-handoff', 'development-gstack-engineering-review']],
    [app.agents.developmentReviewerAgent, ['development-bmad-code-review', 'development-gstack-code-review']],
  ] as const;
  for (const [agent, skills] of cases) {
    assert.deepEqual(Object.keys(await agent.listTools()), []);
    assert.deepEqual((await agent.listSkills()).map(skill => skill.name), [...skills]);
    assert.match(String(await agent.getInstructions()), /不得声称读取了仓库/);
    const result = await agent.generate('请分析我提供的代码：const x = 1', { memory: { thread: `test-${agent.id}`, resource: 'studio-test' } });
    assert.match(result.text, /fixture/);
  }
});
