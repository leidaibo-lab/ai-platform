/** 仓库 JSON 是用例源，Mastra 原生 Dataset/Experiment 是运行与评分事实源；不另建状态库。 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Mastra } from '@mastra/core';
import { expectationSchema } from './scorers.js';

const suiteSchema = z.object({ version: z.string().min(1), datasets: z.array(z.object({ id: z.string().min(1), name: z.string(), targetId: z.string(), cases: z.array(z.object({ id: z.string(), input: z.string().min(1), groundTruth: expectationSchema, metadata: z.record(z.string(), z.unknown()) })).min(1) })).min(1) });

/** 用内容散列隔离数据版本；重复导入同一资产幂等，不改写已有人工作业的数据集。 */
export async function seedNativeDatasets(mastra: Mastra, rootDir: string, mode: 'fixture' | 'live', options: { legacyScoring?: boolean } = {}) {
  const raw = readFileSync(resolve(rootDir, 'evaluations/native/nodes.v1.json'), 'utf8');
  const suite = suiteSchema.parse(JSON.parse(raw));
  const hash = createHash('sha256').update(raw).digest('hex');
  const scorerIds = ['node-contract-coverage-v1'];
  if (mode === 'live') scorerIds.push(options.legacyScoring ? 'node-quality-rubric-v1' : 'node-quality-rubric-v2');
  const datasets = [];
  for (const entry of suite.datasets) {
    mastra.getAgent(entry.targetId);
    const caseIds = new Set(entry.cases.map(
      // 资产内的身份必须唯一，不能被幂等导入吞掉重复案例。
      (item) => item.id,
    ));
    if (caseIds.size !== entry.cases.length) throw new Error(`测试案例ID重复：${entry.id}`);
    const scoringVersion = mode === 'live' && !options.legacyScoring ? '-rubric-v2' : '';
    const id = `${suite.version}-${mode}-${entry.id}-${hash.slice(0, 12)}${scoringVersion}`;
    const found = await mastra.datasets.list({ perPage: false, filters: { datasetIds: [id] } });
    const dataset = found.datasets.length ? await mastra.datasets.get({ id }) : await mastra.datasets.create({ id, name: `${entry.name} · ${suite.version} · ${mode}${scoringVersion}`, description: '节点冻结输入评测；词项覆盖与语义质量分开，不代表审批或全流程通过。', targetType: 'agent', targetIds: [entry.targetId], scorerIds, metadata: { sourceHash: hash, suiteVersion: suite.version, mode } });
    await dataset.addItems({ items: entry.cases.map(
      // externalId 由原生Store执行幂等校验，标准只写groundTruth，不注入被测输入。
      (item) => ({ externalId: item.id, input: item.input, groundTruth: item.groundTruth, metadata: { ...item.metadata, mode, sourceHash: hash, caseId: item.id }, scorerIds }),
    ) });
    datasets.push({ dataset, targetId: entry.targetId, sourceHash: hash });
  }
  return datasets;
}
