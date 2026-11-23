/** 固定 Studio 研发角色评测：保存原始输出供人工复核，不将关键词命中作为质量判定。 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readConfig, resolveModelId } from '../src/mastra/config.js';
import { createStudioApplicationOptions } from '../src/mastra/app.js';

const config = readConfig();
if (config.mode !== 'live') throw new Error('本评测必须显式使用 live 模式');
const suitePath = resolve(config.rootDir, 'evaluations/studio-development/cases.json');
const suite = readFileSync(suitePath, 'utf8');
const cases = (JSON.parse(suite) as { id: string; role: 'product' | 'lead' | 'implementer' | 'reviewer'; prompt: string }[]).filter(item => !process.env.STUDIO_EVAL_CASE || item.id === process.env.STUDIO_EVAL_CASE);
if (!cases.length) throw new Error('未找到指定评测场景');
const directory = resolve(process.env.STUDIO_EVAL_OUTPUT ?? '/tmp/ai-platform-studio-development-eval', randomUUID());
mkdirSync(directory, { recursive: true });
const app = createStudioApplicationOptions(config);
const agents = { product: app.agents.productManagerAgent, lead: app.agents.developmentLeadAgent, implementer: app.agents.developmentImplementerAgent, reviewer: app.agents.developmentReviewerAgent };
try {
  await app.storage.init();
  writeFileSync(resolve(directory, 'metadata.json'), JSON.stringify({ mode: config.mode, model: resolveModelId(config, 'development'), suiteHash: createHash('sha256').update(suite).digest('hex'), cases, assessment: '人工复核，未自动判定质量' }, null, 2));
  await Promise.all(cases.map(async item => {
    const agent = agents[item.role];
    try {
      const result = await agent.generate(item.prompt, { abortSignal: AbortSignal.timeout(60000), memory: { thread: `eval-${randomUUID()}`, resource: `eval-${item.id}` } });
      writeFileSync(resolve(directory, `${item.id}.json`), JSON.stringify({ id: item.id, text: result.text, steps: result.steps }, null, 2));
      if (!result.text.trim()) {
        console.log(`${item.id}: 未产生终答，未完成`);
        process.exitCode = 1;
        return;
      }
      console.log(`${item.id}: 已生成，待人工复核`);
    } catch (error) {
      writeFileSync(resolve(directory, `${item.id}.error.json`), JSON.stringify({ id: item.id, error: String(error) }, null, 2));
      console.log(`${item.id}: 调用失败`);
      process.exitCode = 1;
    }
  }));
  console.log(`结果目录：${directory}`);
} finally { await app.storage.close(); }
