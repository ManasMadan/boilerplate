import { describe, expect, it } from "bun:test";
import { isPlatformSecret, unsafeSecret } from "./secrets-check";

const secret = (value: string, extra = "") =>
  `apiVersion: v1\nkind: Secret\nmetadata:\n  name: boilerplate-api\n${extra}stringData:\n  BETTER_AUTH_SECRET: ${value}\n`;
const sops =
  "sops:\n  age:\n    - recipient: age1example\n      enc: x\n  mac: ENC[AES256_GCM,data:m,iv:i,tag:t,type:str]\n";
const encrypted = `${secret("ENC[AES256_GCM,data:abc,iv:def,tag:ghi,type:str]")}${sops}`;

describe("the secrets check", () => {
  it("passes a Secret SOPS encrypted with age", () => {
    expect(unsafeSecret("api.sops.yaml", encrypted, false)).toBeNull();
  });

  it("refuses values in plain text, even with SOPS metadata", () => {
    expect(unsafeSecret("api.sops.yaml", secret("hunter2"), false)).toContain("not encrypted");
    expect(unsafeSecret("api.sops.yaml", `${secret("hunter2")}${sops}`, false)).toBe(
      "values in plain text: BETTER_AUTH_SECRET",
    );
    expect(
      unsafeSecret("api.sops.yaml", `${secret("ENC[AES256_GCM,x]")}sops: {}\n`, false),
    ).toContain("not encrypted");
  });

  it("refuses files that aren't encrypted Secrets", () => {
    expect(unsafeSecret("api.yaml", encrypted, false)).toBe("only *.sops.yaml files belong here");
    expect(unsafeSecret("api.sops.yaml", "kind: ConfigMap\n", false)).toBe("not a Secret");
    expect(unsafeSecret("api.sops.yaml", "a: [", false)).toContain("not YAML");
    expect(unsafeSecret(".gitkeep", "", false)).toBeNull();
    expect(unsafeSecret(".gitkeep", "x", false)).toBe(".gitkeep must be empty");
  });

  it("keeps namespaces where they belong", () => {
    expect(unsafeSecret("api.sops.yaml", encrypted, true)).toBe(
      "a platform Secret names its namespace",
    );
    const namespaced = `${secret("ENC[AES256_GCM,data:a,iv:b,tag:c,type:str]", "  namespace: mail\n")}${sops}`;
    expect(unsafeSecret("stalwart.sops.yaml", namespaced, true)).toBeNull();
    expect(unsafeSecret("api.sops.yaml", namespaced, false)).toContain("names no namespace");
  });

  it("tells platform Secrets from the application's by path", () => {
    expect(isPlatformSecret("deploy/platform/secrets/staging/stalwart.sops.yaml")).toBe(true);
    expect(isPlatformSecret("deploy/environments/staging/secrets/api.sops.yaml")).toBe(false);
  });
});
