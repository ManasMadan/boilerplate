/** `bun run --filter @repo/fake-stripe start`: the fake, configured from the environment. */
import { afterEach, describe, expect, it, vi } from "vitest";

const REQUIRED = {
  STRIPE_SECRET_KEY: "sk_test_main",
  STRIPE_WEBHOOK_SECRET: "whsec_main",
  STRIPE_PRICE_PRO_MONTHLY: "price_main_monthly",
  STRIPE_PRICE_PRO_YEARLY: "price_main_yearly",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

function configure(env: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries({ ...REQUIRED, ...env })) vi.stubEnv(name, value);
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

describe("starting the fake", () => {
  it.each([
    [
      "on the port given",
      { STRIPE_FAKE_PORT: "0", STRIPE_FAKE_WEBHOOK_URL: "http://127.0.0.1:1/" },
    ],
    ["on 12111 by default", { STRIPE_FAKE_PORT: undefined, STRIPE_FAKE_WEBHOOK_URL: undefined }],
  ])("listens %s with the key and says where", async (_, env) => {
    const write = configure(env);
    const { fake } = await import("./main");
    try {
      if (env.STRIPE_FAKE_PORT === undefined) expect(fake.port).toBe(12111);
      expect(write).toHaveBeenCalledWith(`fake Stripe on ${fake.url}\n`);
      const customers = (key: string) =>
        fetch(`${fake.url}/v1/customers`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
        });
      expect((await customers(REQUIRED.STRIPE_SECRET_KEY)).status).toBe(200);
      expect((await customers("sk_test_other")).status).toBe(401);
    } finally {
      await fake.close();
    }
  });

  it("refuses to start without a required variable", async () => {
    configure({ STRIPE_PRICE_PRO_YEARLY: "" });
    await expect(import("./main")).rejects.toThrow(
      "STRIPE_PRICE_PRO_YEARLY must be set to run the fake Stripe",
    );
  });
});
