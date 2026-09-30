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

describe("webhooks environment", () => {
  it("lets development and tests call exact private addresses", async () => {
    const env = await load({ WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: "127.0.0.1, ::1" });
    expect(env.WEBHOOK_ALLOWED_PRIVATE_ADDRESSES).toEqual(["127.0.0.1", "::1"]);
  });

  it("refuses to start in production with any private address allowed", async () => {
    await expect(
      load({ NODE_ENV: "production", WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: "127.0.0.1" }),
    ).rejects.toThrow("WEBHOOK_ALLOWED_PRIVATE_ADDRESSES must be empty in production");
    vi.resetModules();
    const env = await load({ NODE_ENV: "production", WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: "" });
    expect(env.WEBHOOK_ALLOWED_PRIVATE_ADDRESSES).toEqual([]);
  });
});
