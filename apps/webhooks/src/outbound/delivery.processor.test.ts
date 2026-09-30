import { WEBHOOK_RETRY_DELAYS_MS } from "@repo/jobs";
import { describe, expect, it } from "vitest";
import { retryDelayMs } from "./delivery.processor";

describe("webhook retries", () => {
  it("wait each step of the Standard Webhooks schedule, then its last step", () => {
    expect(WEBHOOK_RETRY_DELAYS_MS.map((_, index) => retryDelayMs(index + 1))).toEqual([
      ...WEBHOOK_RETRY_DELAYS_MS,
    ]);
    const last = WEBHOOK_RETRY_DELAYS_MS.at(-1);
    expect(retryDelayMs(WEBHOOK_RETRY_DELAYS_MS.length + 3)).toBe(last);
  });
});
