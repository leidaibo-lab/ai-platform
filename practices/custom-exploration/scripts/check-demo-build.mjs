#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { gzipSync } from "node:zlib";

const assetsDir = new URL("../demo/dist/assets/", import.meta.url);
const MAX_JS_CHUNK_GZIP = 260 * 1024;
const MAX_TOTAL_JS_GZIP = 430 * 1024;
const MAX_TOTAL_CSS_GZIP = 24 * 1024;

/** 读取构建产物并计算 gzip 字节数。 */
async function readAssetBudgets() {
  const names = await readdir(assetsDir);
  const assets = [];
  for (const name of names) {
    const extension = extname(name);
    if (extension !== ".js" && extension !== ".css") continue;
    const content = await readFile(new URL(name, assetsDir));
    assets.push({ name, extension, rawBytes: content.length, gzipBytes: gzipSync(content).length });
  }
  return assets;
}

/** 将字节数格式化为便于构建日志阅读的 KiB。 */
function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

/** 汇总指定扩展名的 gzip 体积。 */
function sumGzipBytes(assets, extension) {
  let total = 0;
  for (const asset of assets) if (asset.extension === extension) total += asset.gzipBytes;
  return total;
}

/** 读取资源名称，供失败提示避免重复内联回调。 */
function readAssetName(asset) {
  return asset.name;
}

/** 执行渠道构建资源预算，超限时以非零状态阻断回归。 */
async function main() {
  const assets = await readAssetBudgets();
  const javascript = assets.filter(
    // JS 单块预算与总预算需要分别检查。
    (asset) => asset.extension === ".js",
  );
  if (javascript.length < 2) throw new Error("Demo JavaScript 未按 vendor 域拆分");
  for (const asset of assets) {
    console.log(`${asset.name}: raw ${formatKiB(asset.rawBytes)}, gzip ${formatKiB(asset.gzipBytes)}`);
  }
  const oversized = javascript.filter(
    // 单块不得通过拆出多个入口规避最大资源检查。
    (asset) => asset.gzipBytes > MAX_JS_CHUNK_GZIP,
  );
  const totalJs = sumGzipBytes(assets, ".js");
  const totalCss = sumGzipBytes(assets, ".css");
  const failures = [];
  if (oversized.length > 0) {
    failures.push(`JS 单块超过 ${formatKiB(MAX_JS_CHUNK_GZIP)}：${oversized.map(readAssetName).join(", ")}`);
  }
  if (totalJs > MAX_TOTAL_JS_GZIP) failures.push(`JS gzip 总量 ${formatKiB(totalJs)} 超过 ${formatKiB(MAX_TOTAL_JS_GZIP)}`);
  if (totalCss > MAX_TOTAL_CSS_GZIP) failures.push(`CSS gzip 总量 ${formatKiB(totalCss)} 超过 ${formatKiB(MAX_TOTAL_CSS_GZIP)}`);
  if (failures.length > 0) throw new Error(failures.join("；"));
  console.log(`Demo 资源预算通过：JS ${formatKiB(totalJs)}，CSS ${formatKiB(totalCss)}`);
}

await main();
