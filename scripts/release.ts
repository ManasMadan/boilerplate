/**
 * Releases are tags pushed by hand; production moves when its promotion pull request
 * is merged (docs/deploy.md, "Releases → production"):
 *
 *   git tag v1.4.0 && git push origin v1.4.0   release.yml checks the tag and publishes
 *                                              the GitHub release with these notes
 *   bun run promote v1.4.0                     opens production's promotion pull request
 *                                              from your own GitHub login, so CI runs on it
 *
 * `check` and `notes` are what release.yml runs; they work locally too.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, ok, ROOT } from "./lib";

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MOBILE_CONFIG = "apps/mobile/app.config.ts";
const PRODUCTION = "deploy/environments/production/stack.yaml";

/** The sections of the notes, in order; other types (chore, docs, test, …) are left out. */
const SECTIONS: [type: string, title: string][] = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["revert", "Reverts"],
  ["build", "Build and infrastructure"],
];

const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<subject>.+)$/;

export interface Commit {
  hash: string;
  subject: string;
  body: string;
}

/** Markdown release notes from the commits since the last release, newest first. */
export function releaseNotes(commits: Commit[]): string {
  const breaking: string[] = [];
  const sections = new Map<string, string[]>(SECTIONS.map(([type]) => [type, []]));
  for (const commit of commits) {
    const match = CONVENTIONAL.exec(commit.subject)?.groups;
    if (!match?.type || !match.subject) continue;
    const scope = match.scope ? `**${match.scope}:** ` : "";
    const line = `- ${scope}${match.subject} (${commit.hash})`;
    if (match.breaking || /^BREAKING[ -]CHANGE: /m.test(commit.body)) breaking.push(line);
    sections.get(match.type)?.push(line);
  }
  const parts: string[] = [];
  if (breaking.length) parts.push(`## Breaking changes\n\n${breaking.join("\n")}`);
  for (const [type, title] of SECTIONS) {
    const lines = sections.get(type) ?? [];
    if (lines.length) parts.push(`## ${title}\n\n${lines.join("\n")}`);
  }
  return parts.length ? `${parts.join("\n\n")}\n` : "Maintenance only: no user-facing changes.\n";
}

/** The app version in the mobile config, which store builds of a release carry. */
export function mobileVersion(config: string): string | undefined {
  return /^\s*version:\s*"([^"]+)"/m.exec(config)?.[1];
}

/** Production's values with `image.tag` pointed at a build. */
export function withImageTag(values: string, imageTag: string): string {
  const next = values.replace(
    /^(image:\n(?:[ \t]+.*\n)*?[ \t]+tag:)[ \t]*.*$/m,
    `$1 "${imageTag}"`,
  );
  if (next === values && !values.includes(`tag: "${imageTag}"`)) {
    throw new Error(`No image.tag in ${PRODUCTION}`);
  }
  return next;
}

function git(args: string[]) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function gh(args: string[]) {
  const result = spawnSync("gh", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`gh ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function commitsSince(tag: string): Commit[] {
  // The previous release, if there is one: every commit before it is in an older release.
  const previous = spawnSync("git", ["describe", "--tags", "--abbrev=0", "--match=v*", `${tag}^`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const range = previous.status === 0 ? `${previous.stdout.trim()}..${tag}` : tag;
  const log = git(["log", "--no-merges", "--format=%h%x1f%s%x1f%b%x1e", range]);
  return log
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash = "", subject = "", body = ""] = entry.split("\x1f");
      return { hash, subject, body };
    });
}

/** A release tag must be a version, on master, and match the mobile app's version. */
function check(tag: string) {
  const problems: string[] = [];
  if (!TAG.test(tag)) problems.push(`${tag} isn't a version tag like v1.4.0`);
  const commit = git(["rev-list", "-n", "1", tag]);
  const onMaster =
    spawnSync("git", ["merge-base", "--is-ancestor", commit, "origin/master"], { cwd: ROOT })
      .status === 0;
  if (!onMaster) problems.push(`${tag} (${commit.slice(0, 7)}) isn't on master`);
  const version = mobileVersion(git(["show", `${tag}:${MOBILE_CONFIG}`]));
  if (version !== tag.slice(1)) {
    problems.push(
      `${MOBILE_CONFIG} says version ${version ?? "(none)"}: set it to ${tag.slice(1)} on master ` +
        "first (store builds of this release carry it), then tag that commit",
    );
  }
  for (const problem of problems) fail(problem);
  if (problems.length) process.exit(1);
  ok(`${tag} is a release of ${commit.slice(0, 7)}`);
}

/** Opens production's promotion pull request for a release, as whoever runs it. */
function promote(tag: string) {
  git(["fetch", "--quiet", "--tags", "origin", "master"]);
  const commit = git(["rev-list", "-n", "1", tag]);
  // The images are built, signed and on staging once deploy.yml has passed for the commit.
  const runs = JSON.parse(
    gh(["run", "list", "--workflow", "deploy.yml", "--commit", commit, "--json", "conclusion"]),
  ) as { conclusion: string }[];
  if (!runs.some((run) => run.conclusion === "success")) {
    fail(`deploy.yml hasn't passed for ${commit.slice(0, 7)}: no images to promote yet`);
    process.exit(1);
  }
  const imageTag = `sha-${commit}`;
  const branch = `release/production-${tag}`;
  const title = `chore(infra): deploy ${tag} to production`;
  const file = join(ROOT, PRODUCTION);
  const from = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  git(["switch", "--quiet", "-c", branch, "origin/master"]);
  writeFileSync(file, withImageTag(readFileSync(file, "utf8"), imageTag));
  git(["commit", "--quiet", "-m", title, "--", PRODUCTION]);
  git(["push", "--quiet", "-u", "origin", branch]);
  git(["switch", "--quiet", from]);
  const url = gh([
    "pr",
    "create",
    "--base",
    "master",
    "--head",
    branch,
    "--title",
    title,
    "--body",
    `Points production at the images of ${tag} (\`${imageTag}\`), already running on staging. Merging deploys it.`,
  ]);
  ok(`Promotion pull request: ${url}`);
}

if (import.meta.main) {
  const [command, tag] = process.argv.slice(2);
  if (!tag || !["check", "notes", "promote"].includes(command ?? "")) {
    console.error("usage: bun scripts/release.ts check|notes|promote v<major>.<minor>.<patch>");
    process.exit(1);
  }
  if (command === "check") check(tag);
  else if (command === "notes") process.stdout.write(releaseNotes(commitsSince(tag)));
  else promote(tag);
}
