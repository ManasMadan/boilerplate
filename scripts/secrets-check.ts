/**
 * Whether a file in a secrets directory (deploy/environments/<env>/secrets,
 * deploy/platform/secrets/<env>) is safe to commit. `bun run charts:check` runs it on
 * every such file, and the pre-commit hook on the staged ones (`bun scripts/secrets-check.ts
 * <files>`), so a plain Secret doesn't even reach history.
 */
import { readFileSync } from "node:fs";
import { basename, relative } from "node:path";
import { runMain } from "./lib";

/**
 * Why a file in a secrets directory isn't safe to commit, or null when it is: a
 * Kubernetes Secret encrypted by SOPS with age, every value encrypted. `.gitkeep` (empty)
 * holds a directory that has no secrets yet. Application Secrets name no namespace (they
 * go to their Application's: the environment's, or each preview's); platform ones must.
 * `recipients` are the age keys `.sops.yaml` names for the file's path: it must be
 * encrypted to exactly those, so a file copied from another environment's directory (a
 * staging Secret into the previews') is refused rather than decrypted where it lands.
 */
export function unsafeSecret(
  name: string,
  text: string,
  platform: boolean,
  recipients?: string[],
): string | null {
  if (name === ".gitkeep") {
    return text.trim() === "" ? null : ".gitkeep must be empty";
  }
  if (!name.endsWith(".sops.yaml")) {
    return "only *.sops.yaml files belong here";
  }
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (error) {
    return `not YAML: ${(error as Error).message}`;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return "not one YAML document";
  }
  const { kind, metadata, sops, data, stringData } = doc as Record<string, unknown>;
  if (kind !== "Secret") {
    return "not a Secret";
  }
  return (
    namespaceProblem((metadata ?? {}) as Record<string, unknown>, platform) ??
    encryptionProblem(sops, recipients) ??
    valuesProblem({
      ...((data ?? {}) as Record<string, unknown>),
      ...((stringData ?? {}) as Record<string, unknown>),
    })
  );
}

/** Platform Secrets name their namespace; application ones go to their Application's. */
function namespaceProblem(meta: Record<string, unknown>, platform: boolean) {
  if (platform && !meta.namespace) {
    return "a platform Secret names its namespace";
  }
  if (!platform && meta.namespace) {
    return "an application Secret names no namespace (it goes to its Application's)";
  }
  return null;
}

/** Encrypted by sops with age, to exactly `recipients` when they're given. */
function encryptionProblem(sops: unknown, recipients: string[] | undefined) {
  const encryption = sops as { mac?: unknown; age?: { recipient?: unknown }[] } | undefined;
  if (!encryption?.mac || !Array.isArray(encryption.age) || encryption.age.length === 0) {
    return "not encrypted with sops and age (sops --encrypt --in-place)";
  }
  if (!recipients) {
    return null;
  }
  const actual = encryption.age.map((entry) => String(entry.recipient)).sort();
  if (actual.join() === [...recipients].sort().join()) {
    return null;
  }
  return `encrypted to ${actual.join(", ")}, not the keys .sops.yaml names for this directory (${recipients.join(", ")}); re-encrypt it: sops updatekeys`;
}

/** At least one value, and every one encrypted. */
function valuesProblem(values: Record<string, unknown>) {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return "has no values";
  }
  const plain = entries.filter(([, value]) => !String(value).startsWith("ENC[AES256_GCM,"));
  return plain.length > 0 ? `values in plain text: ${plain.map(([key]) => key).join(", ")}` : null;
}

/**
 * The age keys `.sops.yaml` (its text) names for a path relative to the repository: the
 * first creation rule whose path_regex matches, as sops picks it. Undefined when none does.
 */
export function recipientsFor(path: string, sopsConfig: string): string[] | undefined {
  const { creation_rules: rules = [] } = Bun.YAML.parse(sopsConfig) as {
    creation_rules?: { path_regex?: string; age?: string }[];
  };
  const rule = rules.find((candidate) => new RegExp(candidate.path_regex ?? "").test(path));
  return rule?.age
    ?.split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

/** Platform Secrets live under deploy/platform/secrets and must name their namespace. */
export const isPlatformSecret = (path: string) => path.includes("deploy/platform/secrets/");

/** Checks each of `paths` against `.sops.yaml` (its text); the exit code. */
export function checkSecrets(
  paths = process.argv.slice(2),
  sopsConfig = readFileSync(".sops.yaml", "utf8"),
): number {
  const problems = paths
    .map((path) => {
      const problem = unsafeSecret(
        basename(path),
        readFileSync(path, "utf8"),
        isPlatformSecret(path),
        recipientsFor(relative(process.cwd(), path), sopsConfig),
      );
      return problem && `${path}: ${problem}`;
    })
    .filter(Boolean);
  for (const problem of problems) {
    console.error(`  \x1b[31m✖\x1b[0m ${problem}`);
  }
  if (problems.length === 0) {
    return 0;
  }
  console.error(
    "\nEncrypt with `sops --encrypt --in-place <file>` (deploy/README.md) and stage it again.",
  );
  return 1;
}

await runMain(import.meta, checkSecrets);
