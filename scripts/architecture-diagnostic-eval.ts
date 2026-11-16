/** 复用失败业务的冻结产品/上下文单独探测架构；原Run与旧证据只读。 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readConfig } from '../src/mastra/config.js';
import { stateV2Schema, planV2Schema, validatePlanV2 } from '../src/development/v2/contracts.js';
import { developmentHash } from '../src/development/contracts.js';
import { seedDevelopment } from '../src/development-service.js';
import { DevelopmentExecution } from '../src/development-execution.js';
import { loadDevelopmentMethods } from '../src/development/v2/methods.js';
import { invokeV2 } from '../src/development/v2/invoke.js';
import { validateIdentityV2 } from '../src/development/v2/gates.js';
import { generateV2 } from '../src/development/v2/agents.js';
import { parseDevelopmentJson } from '../src/development/agents.js';

const origin = resolve(process.argv[2]);
const previous = JSON.parse(readFileSync(resolve(origin, 'report.json'), 'utf8'));
const state = stateV2Schema.parse(previous.result.development);
const config = { ...readConfig(), mode: 'live' as const };
if (!config.apiKey) throw new Error('缺少真实模型凭据');
const directory = resolve('.data/evaluations', `architecture-diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(directory, { recursive: true });
seedDevelopment(resolve(directory, 'run'), state.input);
const execution = new DevelopmentExecution(resolve(directory, 'run/candidate'), state.input.project.writablePaths, state.input.project.checkFiles);
const report: any = { originRunId: previous.runId, originalProductHash: state.input.source.hash, originalContextHash: developmentHash(state.context), modelId: config.modelId, admission: null, status: 'running' };
/** 此探测仅诊断架构阶段，不宣称已通过原生审批或完整Workflow。 */
function save() { writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2)); }
save();
try {
  const methods = loadDevelopmentMethods(config.rootDir);
  validateIdentityV2(state, config, methods.hash);
  const called = await invokeV2(config, execution, 'architect', { ...state, outcome: 'in-progress', recovery: null, calls: 0, faults: [], recoveries: [] }, [], { priorGates: state.gates, priorReports: state.codeReviews }, methods, generateV2,
    /** 使用与正式架构步骤完全相同的schema与宿主约束。 */
    (text) => validatePlanV2(planV2Schema.parse(parseDevelopmentJson(text)), state),
  );
  report.status = called.entry ? 'architecture-valid' : 'architecture-invalid'; report.faults = called.state.faults;
  report.recovery = called.state.recovery; report.entry = called.entry; save();
  console.log(JSON.stringify({ directory, status: report.status, faults: report.faults }));
} finally { await execution.close(); }
