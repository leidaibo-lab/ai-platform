#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runRuntimeRoutingScenarioSuite,
  writeRuntimeRoutingScenarioReport,
} from "../src/evaluation/runtime-routing-scenario-runner.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** 加载 CLI 参数、运行 Runtime 路由评测并写入分模式报告。 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runRuntimeRoutingScenarioSuite({
    rootDir,
    mode: options.mode,
    scenarioIds: options.scenarioIds,
    modelAlias: options.modelAlias,
    keepArtifacts: options.keepArtifacts,
  });
  const reportPath = options.reportPath || defaultReportPath(options.mode);
  const writtenPath = await writeRuntimeRoutingScenarioReport(report, reportPath);
  printReportSummary(report, writtenPath);
  if (report.summary.failed > 0) process.exitCode = 1;
}

/** 解析模式、场景白名单、模型别名、报告位置和调试资产开关。 */
function parseArguments(argumentsList) {
  const options = {
    mode: "deterministic",
    scenarioIds: [],
    modelAlias: undefined,
    reportPath: undefined,
    keepArtifacts: false,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--keep-artifacts") {
      options.keepArtifacts = true;
      continue;
    }
    const value = argumentsList[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    if (argument === "--mode") options.mode = value;
    else if (argument === "--scenario") options.scenarioIds.push(value);
    else if (argument === "--model") options.modelAlias = value;
    else if (argument === "--report") options.reportPath = resolve(value);
    else throw new Error(`unknown argument: ${argument}`);
    index += 1;
  }
  return options;
}

/** 返回忽略目录中的默认分模式 JSON 报告路径。 */
function defaultReportPath(mode) {
  return resolve(rootDir, ".data", "evaluations", `runtime-routing-${mode}.json`);
}

/** 输出核心路由指标；详细逐轮证据仅保存在 JSON 报告。 */
function printReportSummary(report, reportPath) {
  const metrics = report.metrics;
  console.log(
    `Runtime routing (${report.mode}): ${report.summary.passed}/${report.summary.executed} scenarios passed`,
  );
  console.log(`Conclusion policy: ${report.conclusionPolicy}`);
  console.log(
    `Operation/source/evidence/active: ${metrics.operationAccuracy}/${metrics.sourceImageAccuracy}/${metrics.evidenceValidity}/${metrics.activeImageAccuracy}`,
  );
  console.log(`Wrong image side effects: ${metrics.wrongImageSideEffectRate}`);
  console.log(`Classifier tokens: ${report.usage.totalTokens ?? "unavailable"}`);
  console.log(
    `Routing average/P95: ${report.latency.routing.averageMs ?? "unavailable"}/${report.latency.routing.p95Ms ?? "unavailable"} ms`,
  );
  console.log(`Report: ${reportPath}`);
}

main().catch(reportRunnerFailure);

/** 将 CLI 基础设施异常收口为单行安全错误。 */
function reportRunnerFailure(error) {
  console.error(`Runtime routing scenario runner failed: ${String(error?.message || error).slice(0, 1000)}`);
  process.exitCode = 1;
}
