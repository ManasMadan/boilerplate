/**
 * Makes this repository a new project: rewrites the template's identity (the GitHub
 * owner and repository, the image registry, the product name, the mobile bundle id and
 * URL scheme, and the `boilerplate` name in compose, kind, Kubernetes labels and
 * resources, cookies and test addresses) in every tracked text file, then fails if any
 * old identifier is left.
 *
 *   bun run rename <name> --owner <github owner> [--product "<Product>"] [--bundle-id <id>]
 *
 * `name` is lowercase letters, digits and dashes (it names Kubernetes resources and the
 * compose project). The product defaults to the name capitalised, the bundle id to
 * `com.<name without dashes>.app`. Run it once, on a clean tree, then review the diff.
 * The default branch (`master`) stays: rename it in GitHub's settings and the
 * workflows together if you want another.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fail, ok, ROOT, runMain, runSync } from "./lib";

export interface Identity {
  name: string;
  owner: string;
  product: string;
  bundleId: string;
}

/** This script and its test name the template on purpose: they're left as they are. */
const SELF = new Set(["scripts/rename.ts", "scripts/rename.test.ts"]);

/** What the template is called, as `rename` finds it. */
const OLD = { name: "boilerplate", owner: "ManasMadan", product: "Boilerplate" };

/** The replacements, most specific first: each later one would mangle an earlier match. */
export function replacements({ name, owner, product, bundleId }: Identity): [RegExp, string][] {
  return [
    [/ManasMadan\/boilerplate/g, `${owner}/${name}`],
    [/ghcr\.io\/manasmadan\/boilerplate/g, `ghcr.io/${owner.toLowerCase()}/${name}`],
    [/ManasMadan/g, owner],
    [/manasmadan/g, owner.toLowerCase()],
    // The app store identifiers (with their .development / .preview variants), and the
    // push tests' APNs topic.
    [/com\.boilerplate\.app/g, bundleId],
    [/dev\.boilerplate\.app/g, bundleId],
    [/Boilerplate/g, product],
    [/boilerplate/g, name],
  ];
}

export function rewrite(text: string, identity: Identity) {
  return replacements(identity).reduce((out, [pattern, to]) => out.replace(pattern, to), text);
}

/** The identity from the command line, with its defaults; throws on a bad value. */
export function identityFrom(argv: string[]): Identity {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      owner: { type: "string" },
      product: { type: "string" },
      "bundle-id": { type: "string" },
    },
  });
  const [name] = positionals;
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(
      "The name must be lowercase letters, digits and dashes, starting with a letter.",
    );
  }
  if (!values.owner || !/^[A-Za-z0-9-]+$/.test(values.owner)) {
    throw new Error("--owner must be the GitHub user or organization that owns the repository.");
  }
  if (name === OLD.name) {
    throw new Error(`The project is already called ${OLD.name}.`);
  }
  const bundleId = values["bundle-id"] ?? `com.${name.replaceAll("-", "")}.app`;
  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(bundleId)) {
    throw new Error("--bundle-id must be reverse DNS, like com.example.app.");
  }
  const product = values.product ?? name.charAt(0).toUpperCase() + name.slice(1);
  return { name, owner: values.owner, product, bundleId };
}

/** Old identifiers still in `files` (path: line), after a rename. */
export function leftovers(files: Map<string, string>) {
  const old = new RegExp(`${OLD.name}|${OLD.owner}`, "i");
  return [...files].flatMap(([path, text]) =>
    text
      .split("\n")
      .flatMap((line, index) => (old.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : [])),
  );
}

/** Rewrites every tracked text file under `root`; returns the paths it changed. */
export function rename(root: string, identity: Identity) {
  const tracked = runSync("git", ["ls-files", "-z"], { cwd: root })
    .stdout.split("\0")
    .filter(Boolean);
  const files = new Map<string, string>();
  const changed: string[] = [];
  for (const path of tracked.filter((path) => !SELF.has(path))) {
    const bytes = readFileSync(join(root, path));
    if (bytes.includes(0)) {
      continue; // binary
    }
    const before = bytes.toString("utf8");
    const after = rewrite(before, identity);
    files.set(path, after);
    if (after !== before) {
      writeFileSync(join(root, path), after);
      changed.push(path);
    }
  }
  return { changed, left: leftovers(files) };
}

/** The command: renames the checkout at `root`; the exit code. */
export function main(argv = process.argv.slice(2), root = ROOT): number {
  let identity: Identity;
  try {
    identity = identityFrom(argv);
  } catch (error) {
    fail((error as Error).message);
    return 1;
  }
  const { changed, left } = rename(root, identity);
  ok(`${changed.length} files rewritten for ${identity.owner}/${identity.name}`);
  if (left.length > 0) {
    for (const line of left) {
      console.error(`  ${line}`);
    }
    fail(`${left.length} lines still name the template; change them by hand.`);
    return 1;
  }
  ok(
    "No old identifier left. Run `bun install` (the lockfile's root name changed), then review the diff.",
  );
  return 0;
}

await runMain(import.meta, main);
