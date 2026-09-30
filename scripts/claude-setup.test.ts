/**
 * The Claude Code setup's frontmatter: Claude Code ignores a field it doesn't know and
 * drops every field of a block that isn't valid YAML (a stray ": " in a description is
 * enough), both silently. This fails instead. The fields are the ones documented at
 * code.claude.com/docs/en/skills, /sub-agents and /memory (rules read only `paths`).
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib";

const SKILL_FIELDS = new Set([
  "name",
  "description",
  "when_to_use",
  "argument-hint",
  "arguments",
  "disable-model-invocation",
  "user-invocable",
  "allowed-tools",
  "disallowed-tools",
  "model",
  "effort",
  "context",
  "agent",
  "background",
  "hooks",
  "paths",
  "shell",
  "metadata",
  "license",
  "compatibility",
]);
const AGENT_FIELDS = new Set([
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "permissionMode",
  "mcpServers",
  "hooks",
  "maxTurns",
  "skills",
  "initialPrompt",
  "memory",
  "effort",
  "background",
  "omitClaudeMd",
  "isolation",
  "color",
  "experimental",
]);

const CLAUDE = join(ROOT, ".claude");

function frontmatter(path: string): Record<string, unknown> {
  const text = readFileSync(path, "utf8");
  if (!text.startsWith("---\n")) throw new Error(`${path} has no frontmatter`);
  const end = text.indexOf("\n---", 3);
  return Bun.YAML.parse(text.slice(4, end)) as Record<string, unknown>;
}

const skills = readdirSync(join(CLAUDE, "skills"));
const agents = readdirSync(join(CLAUDE, "agents")).map((file) => file.replace(/\.md$/, ""));

describe("skills", () => {
  it.each(skills)("%s has valid, documented frontmatter", (skill) => {
    const fields = frontmatter(join(CLAUDE, "skills", skill, "SKILL.md"));
    expect(Object.keys(fields).filter((field) => !SKILL_FIELDS.has(field))).toEqual([]);
    expect(fields.name).toBe(skill);
    expect(typeof fields.description).toBe("string");
    if (typeof fields.agent === "string") expect(agents).toContain(fields.agent);
  });

  it("start the seam swaps only when a person asks", () => {
    for (const skill of skills.filter((name) => name.startsWith("swap-"))) {
      expect(frontmatter(join(CLAUDE, "skills", skill, "SKILL.md"))).toMatchObject({
        "disable-model-invocation": true,
      });
    }
  });
});

describe("agents", () => {
  it.each(agents)("%s has valid, documented frontmatter", (agent) => {
    const fields = frontmatter(join(CLAUDE, "agents", `${agent}.md`));
    expect(Object.keys(fields).filter((field) => !AGENT_FIELDS.has(field))).toEqual([]);
    expect(fields.name).toBe(agent);
    expect(typeof fields.description).toBe("string");
    expect(typeof fields.model).toBe("string");
    expect(typeof fields.permissionMode).toBe("string");
    for (const skill of (fields.skills as string[] | undefined) ?? []) {
      expect(skills).toContain(skill);
    }
  });
});

describe("rules", () => {
  it.each(readdirSync(join(CLAUDE, "rules")))("%s scopes itself with paths only", (rule) => {
    const fields = frontmatter(join(CLAUDE, "rules", rule));
    expect(Object.keys(fields)).toEqual(["paths"]);
    expect(Array.isArray(fields.paths)).toBe(true);
  });
});
