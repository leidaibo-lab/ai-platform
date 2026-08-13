#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runRuntimeScenarioSuite,
  writeRuntimeScenarioReport,
} from "../src/evaluation/runtime-scenario-runner.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** 加载 CLI 参数、运行对应模型模式并写入结构化报告。 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runRuntimeScenarioSuite({
    rootDir,
    mode: options.mode,
    scenarioIds: options.scenarioIds,
    modelAlias: options.modelAlias,
    keepArtifacts: options.keepArtifacts,
  });
  const reportPath = options.reportPath || defaultReportPath(options.mode);
  const writtenPath = await writeRuntimeScenarioReport(report, reportPath);
  printReportSummary(report, writtenPath);
  if (report.summary.failed > 0) process.exitCode = 1;
}

/** 解析双模式、场景白名单、报告位置和调试资产开关。 */
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

/** 返回默认忽略目录中的分模式 JSON 报告路径。 */
function defaultReportPath(mode) {
  return resolve(rootDir, ".data", "evaluations", `runtime-scenarios-${mode}.json`);
}

/** 输出可扫描摘要；详细证据保留在 JSON，不在终端打印提示词或 ToolResult 正文。 */
function printReportSummary(report, reportPath) {
  const rate = report.summary.executed > 0
    ? `${report.summary.passed}/${report.summary.executed}`
    : "0/0";
  console.log(`Runtime scenarios (${report.mode}): ${rate} passed, ${report.summary.skipped} skipped`);
  console.log(`Conclusion policy: ${report.conclusionPolicy}`);
  console.log(`Model aliases: ${report.models.aliases.join(", ") || "unavailable"}`);
  console.log(`Actual models: ${report.models.actual.join(", ") || "unavailable"}`);
  console.log(`Tokens: ${report.usage.totalTokens ?? "unavailable"}`);
  console.log(`Average/P95: ${report.latency.averageMs ?? "unavailable"}/${report.latency.p95Ms ?? "unavailable"} ms`);
  console.log(`Report: ${reportPath}`);
  for (const scenario of report.scenarios) {
    console.log(`- ${scenario.id}@${scenario.fixtureVersion}: ${scenario.status}`);
  }
}

main().catch(reportRunnerFailure);

/** 将 CLI 基础设施错误收口为单行安全错误。 */
function reportRunnerFailure(error) {
  console.error(`Runtime scenario runner failed: ${String(error?.message || error).slice(0, 1000)}`);
  process.exitCode = 1;
}
