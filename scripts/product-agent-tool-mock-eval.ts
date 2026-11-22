import { resolve } from 'node:path';
import { evaluateProductAgentToolMock } from '../src/evaluation/product-agent-tool-mock.js';

const result = await evaluateProductAgentToolMock(resolve('.'));
console.log(JSON.stringify({ mode: 'fixture', authority: 'tool-mock-mechanics-only', ...result }));
if (result.status !== 'completed' || result.failedCount || result.persistenceFailures || result.itemCount !== 1 || result.served.join(',') !== 'practiceInfo' || result.liveCalls !== 0 || result.unconsumed !== 0) process.exitCode = 1;
