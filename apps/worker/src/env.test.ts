import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** env.ts as a fresh process would load it, with these variables. */
async function load(variables: Record<string, string>) {
  for (const [key, value] of Object.entries(variables)) vi.stubEnv(key, value);
  return (await import("./env")).env;
}

describe("worker environment", () => {
  it("lets development skip virus scanning", async () => {
    const env = await load({ S3_BUCKET: "uploads", FILE_SCANNER: "none" });
    expect(env.FILE_SCANNER).toBe("none");
  });

  it("refuses to take uploads in production without scanning them", async () => {
    await expect(
      load({ NODE_ENV: "production", S3_BUCKET: "uploads", FILE_SCANNER: "none" }),
    ).rejects.toThrow("FILE_SCANNER=none is for development only: uploads must be scanned");
    vi.resetModules();
    // Without files, there's nothing to scan.
    expect(
      (await load({ NODE_ENV: "production", S3_BUCKET: "", FILE_SCANNER: "none" })).S3_BUCKET,
    ).toBeUndefined();
  });
});
