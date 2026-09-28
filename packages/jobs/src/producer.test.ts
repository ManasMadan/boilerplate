import { describe, expect, it } from "vitest";
import { parseJob } from "./producer";

const payload = {
  template: "auth.otp",
  to: { email: "ada@example.com", locale: "en" },
  data: { otp: "123456", purpose: "sign-in", expiresInMinutes: 5 },
} as const;

describe("parseJob", () => {
  it("returns metadata and a validated payload", () => {
    const { meta, payload: parsed } = parseJob("notifications-critical", "send", {
      meta: { requestId: "r-1" },
      payload,
    });
    expect(meta).toEqual({ requestId: "r-1" });
    expect(parsed.template).toBe("auth.otp");
  });

  it("rejects payloads that break the contract, and data without the envelope", () => {
    expect(() =>
      parseJob("notifications-critical", "send", {
        meta: {},
        payload: { ...payload, to: { email: "nope", locale: "en" } },
      }),
    ).toThrow();
    expect(() => parseJob("notifications-critical", "send", payload)).toThrow();
  });
});
