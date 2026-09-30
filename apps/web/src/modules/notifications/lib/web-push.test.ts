import { describe, expect, it } from "vitest";
import { toDevice } from "./web-push";

const subscription = (keys?: { p256dh?: string; auth?: string }) =>
  ({
    endpoint: "https://push.example/abc",
    toJSON: () => ({ endpoint: "https://push.example/abc", keys }),
  }) as unknown as PushSubscription;

describe("a browser push subscription", () => {
  it("registers with its encryption keys", () => {
    expect(toDevice(subscription({ p256dh: "p", auth: "a" }))).toEqual({
      platform: "web",
      subscription: { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } },
    });
  });

  it("is refused without them: nothing could ever be sent to it", () => {
    expect(() => toDevice(subscription())).toThrow(/no encryption keys/);
    expect(() => toDevice(subscription({ p256dh: "p" }))).toThrow(/no encryption keys/);
  });
});
