import { describe, expect, it } from "vitest";
import { tokenIsDead } from "./fcm";

const invalidArgument = (field: string) =>
  JSON.stringify({
    error: { status: "INVALID_ARGUMENT", details: [{ fieldViolations: [{ field }] }] },
  });

describe("an FCM error", () => {
  it("means the token is dead when it's unregistered or malformed", () => {
    expect(tokenIsDead(404, "{}")).toBe(true);
    expect(tokenIsDead(400, '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}')).toBe(true);
    expect(tokenIsDead(400, invalidArgument("message.token"))).toBe(true);
  });

  it("doesn't when the fault is our message's, or the answer isn't one we know", () => {
    expect(tokenIsDead(400, invalidArgument("message.notification.title"))).toBe(false);
    expect(tokenIsDead(500, '{"error":{"status":"INTERNAL"}}')).toBe(false);
    expect(tokenIsDead(502, "<html>bad gateway</html>")).toBe(false);
  });
});
