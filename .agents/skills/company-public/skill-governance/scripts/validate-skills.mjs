#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const projectRoot = resolve(new URL("../../../../../", import.meta.url).pathname);
const skillsRoot = join(projectRoot, ".agents", "skills");
const allowedPatterns = new Set(["tool-wrapper", "generator", "reviewer", "inversion", "pipeline"]);
const issues = [];

if (!existsSync(skillsRoot)) {
  fail(`Missing skills root: ${relative(projectRoot, skillsRoot)}`);
}

validateRootShape();
for (const skillFile of findSkillFiles(skillsRoot)) {
  validateSkill(skillFile);
}

if (issues.length > 0) {
  console.error("SKILL_STRUCTURE_ERRORS");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log("SKILL_STRUCTURE_OK");

// 检查项目根目录，避免出现绕过统一 Skill 路由的平行资产目录。
function validateRootShape() {
  for (const name of [".cursor", ".trae", ".qoder", ".vscode", "skills"]) {
    const target = join(projectRoot, name);
    if (existsSync(target)) {
      issues.push(`Forbidden parallel skill directory exists: ${name}`);
    }
  }
}

/**
 * 递归查找 Skill 入口文件并返回稳定排序，保证校验输出顺序可复现。
 *
 * @param {string} root - Skill 根目录。
 * @returns {string[]} SKILL.md 文件绝对路径列表。
 */
function findSkillFiles(root) {
  const results = [];
  // 深度遍历目录，只收集约定名称的 Skill 入口文件。
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry === "SKILL.md") {
        results.push(fullPath);
      }
    }
  };
  walk(root);
  return results.sort();
}

/**
 * 校验单个 Skill 的目录层级、名称和必填 frontmatter 元数据。
 *
 * @param {string} skillFile - SKILL.md 文件绝对路径。
 * @returns {void}
 */
function validateSkill(skillFile) {
  const rel = relative(skillsRoot, skillFile);
  const parts = rel.split("/");
  if (parts.length !== 3 || parts[2] !== "SKILL.md") {
    issues.push(`${rel}: SKILL.md must live at <top>/<skill>/SKILL.md`);
    return;
  }

  const [top, skill] = parts;
  const expectedName = `${top}-${skill}`;
  const frontmatter = parseFrontmatter(skillFile);
  if (!frontmatter) {
    issues.push(`${rel}: missing YAML frontmatter`);
    return;
  }

  if (frontmatter.name !== expectedName) {
    issues.push(`${rel}: name must be ${expectedName}, got ${frontmatter.name || "<empty>"}`);
  }
  if (!frontmatter.description) {
    issues.push(`${rel}: description is required`);
  }
  if (!frontmatter.metadata.pattern) {
    issues.push(`${rel}: metadata.pattern is required`);
  } else if (!allowedPatterns.has(frontmatter.metadata.pattern)) {
    issues.push(
      `${rel}: metadata.pattern must be one of ${[...allowedPatterns].join(", ")}, got ${frontmatter.metadata.pattern}`,
    );
  }
  if (!frontmatter.metadata.author) {
    issues.push(`${rel}: metadata.author is required`);
  }
  if (!frontmatter.metadata.version) {
    issues.push(`${rel}: metadata.version is required`);
  }

  const skillDir = dirname(skillFile);
  if (basename(dirname(skillDir)) !== top || basename(skillDir) !== skill) {
    issues.push(`${rel}: unexpected path layout`);
  }
}

/**
 * 解析当前治理规则使用的扁平 YAML frontmatter 及 metadata 子字段。
 *
 * @param {string} filePath - SKILL.md 文件路径。
 * @returns {object|null} frontmatter 数据；格式缺失或未闭合时返回 null。
 */
function parseFrontmatter(filePath) {
  const content = readFileSync(filePath, "utf8");
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return null;

  const result = { metadata: {} };
  let inMetadata = false;
  for (const line of content.slice(4, end).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true;
      continue;
    }
    const match = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, indent, key, rawValue] = match;
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    if (inMetadata && indent.length > 0) {
      result.metadata[key] = value;
    } else {
      inMetadata = false;
      result[key] = value;
    }
  }
  return result;
}

// 输出无法继续校验的基础错误并以失败状态结束进程。
function fail(message) {
  console.error(message);
  process.exit(1);
}
