/**
 * Whether a file in a secrets directory (deploy/environments/<env>/secrets,
 * deploy/platform/secrets/<env>) is safe to commit. `bun run charts:check` runs it on
 * every such file, and the pre-commit hook on the staged ones (`bun scripts/secrets-check.ts
 * <files>`), so a plain Secret doesn't even reach history.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * Why a file in a secrets directory isn't safe to commit, or null when it is: a
 * Kubernetes Secret encrypted by SOPS with age, every value encrypted. `.gitkeep` (empty)
 * holds a directory that has no secrets yet. Application Secrets name no namespace (they
 * go to their Application's: the environment's, or each preview's); platform ones must.
 */
export function unsafeSecret(name: string, text: string, platform: boolean): string | null {
  if (name === ".gitkeep") return text.trim() === "" ? null : ".gitkeep must be empty";
  if (!name.endsWith(".sops.yaml")) return "only *.sops.yaml files belong here";
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (error) {
    return `not YAML: ${(error as Error).message}`;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return "not one YAML document";
  const { kind, metadata, sops, data, stringData } = doc as Record<string, unknown>;
  if (kind !== "Secret") return "not a Secret";
  const meta = (metadata ?? {}) as Record<string, unknown>;
  if (platform && !meta.namespace) return "a platform Secret names its namespace";
  if (!platform && meta.namespace) {
    return "an application Secret names no namespace (it goes to its Application's)";
  }
  const encryption = sops as { mac?: unknown; age?: unknown[] } | undefined;
  if (!encryption?.mac || !Array.isArray(encryption.age) || encryption.age.length === 0) {
    return "not encrypted with sops and age (sops --encrypt --in-place)";
  }
  const values = Object.entries({
    ...((data ?? {}) as Record<string, unknown>),
    ...((stringData ?? {}) as Record<string, unknown>),
  });
  if (values.length === 0) return "has no values";
  const plain = values.filter(([, value]) => !String(value).startsWith("ENC[AES256_GCM,"));
  return plain.length > 0 ? `values in plain text: ${plain.map(([key]) => key).join(", ")}` : null;
}

/** Platform Secrets live under deploy/platform/secrets and must name their namespace. */
export const isPlatformSecret = (path: string) => path.includes("deploy/platform/secrets/");

if (import.meta.main) {
  const problems = process.argv
    .slice(2)
    .map((path) => {
      const problem = unsafeSecret(
        basename(path),
        readFileSync(path, "utf8"),
        isPlatformSecret(path),
      );
      return problem && `${path}: ${problem}`;
    })
    .filter(Boolean);
  for (const problem of problems) console.error(`  \x1b[31m✖\x1b[0m ${problem}`);
  if (problems.length) {
    console.error(
      "\nEncrypt with `sops --encrypt --in-place <file>` (deploy/README.md) and stage it again.",
    );
    process.exit(1);
  }
}
