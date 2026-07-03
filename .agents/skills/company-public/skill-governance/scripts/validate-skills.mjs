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

function validateRootShape() {
  for (const name of [".cursor", ".trae", ".qoder", ".vscode", "skills"]) {
    const target = join(projectRoot, name);
    if (existsSync(target)) {
      issues.push(`Forbidden parallel skill directory exists: ${name}`);
    }
  }
}

function findSkillFiles(root) {
  const results = [];
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

function fail(message) {
  console.error(message);
  process.exit(1);
}

