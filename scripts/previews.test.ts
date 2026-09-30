/**
 * What a pull request can put into its preview: only its images. The charts, values and
 * Secrets come from the branch it targets, and the Secrets decrypt with the preview key
 * alone, so a fork (or a copied staging Secret) can't run with staging's secrets.
 */
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("the previews ApplicationSet", () => {
  const { spec } = Bun.YAML.parse(read("deploy/argocd/appsets/previews.yaml")) as {
    spec: {
      templatePatch: string;
      template: {
        spec: { syncPolicy: { retry?: { limit: number; backoff: { maxDuration: string } } } };
      };
    };
  };
  const patch = spec.templatePatch;

  it("keeps retrying a sync until the pull request's images are pushed", () => {
    // preview.yml takes about ten minutes to push them; the retries have to outlast it.
    const retry = spec.template.spec.syncPolicy.retry;
    expect(retry?.limit).toBeGreaterThanOrEqual(5);
    expect(retry?.backoff.maxDuration).toBe("5m");
  });

  it("takes charts, values and Secrets from the target branch, never the pull request's", () => {
    const revisions = [...patch.matchAll(/targetRevision:\s*(.+)/g)].map((m) => m[1]?.trim());
    expect(revisions.length).toBeGreaterThan(0);
    for (const revision of revisions) expect(revision).toBe('"{{ .target_branch }}"');
  });

  it("runs the pull request's images", () => {
    expect(patch).toContain('value: "sha-{{ .head_sha }}"');
  });

  it("decrypts the preview Secrets with the preview key", () => {
    expect(patch).toMatch(/name: sops\s+env:\s+- \{ name: AGE_KEY, value: preview \}/);
  });
});

describe("a preview's mail", () => {
  const values = Bun.YAML.parse(read("deploy/environments/preview/stack.yaml")) as {
    services: { notifications: { caBundle: string; env: { SMTP_URL: string } } };
  };

  it("goes to the preview's own Mailpit, never out", () => {
    const { caBundle, env } = values.services.notifications;
    expect(new URL(env.SMTP_URL).host).toBe("mailpit:1025");
    expect(caBundle).toBe("mailpit-tls");
  });
});

describe("the sops plugin", () => {
  const values = Bun.YAML.parse(read("deploy/argocd/argo-cd-values.yaml")) as {
    configs: { cmp: { plugins: { sops: { generate: { args: string[] } } } } };
  };
  const script = values.configs.cmp.plugins.sops.generate.args[0] as string;

  /** Runs the plugin's script in a directory with one secret and a stand-in `sops`. */
  function generate(ageKey?: string) {
    const dir = mkdtempSync(join(tmpdir(), "sops-plugin-"));
    writeFileSync(join(dir, "api.sops.yaml"), "");
    const sops = join(dir, "sops");
    writeFileSync(sops, '#!/bin/sh\necho "key=$SOPS_AGE_KEY_FILE file=$2"\n');
    chmodSync(sops, 0o755);
    return Bun.spawnSync(["sh", "-c", script], {
      cwd: dir,
      env: { PATH: `${dir}:/usr/bin:/bin`, ...(ageKey ? { ARGOCD_ENV_AGE_KEY: ageKey } : {}) },
    });
  }

  it("decrypts with the cluster's key by default", () => {
    const result = generate();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("key=/sops/keys.txt file=api.sops.yaml");
  });

  it("decrypts with the preview key alone when asked", () => {
    expect(generate("preview").stdout.toString()).toContain("key=/sops/preview.txt");
  });

  it("refuses any other key file", () => {
    const result = generate("../etc/passwd");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("unknown AGE_KEY");
  });
});
