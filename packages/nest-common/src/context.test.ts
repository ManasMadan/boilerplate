import { describe, expect, it } from "vitest";
import { contextLogFields, currentContext, runWithContext, updateContext } from "./context";

describe("request context", () => {
  it("is there for everything the call awaits, and gone outside it", async () => {
    await runWithContext({ requestId: "r-1", orgId: "o-1" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentContext()).toEqual({ requestId: "r-1", orgId: "o-1" });
    });
    expect(currentContext()).toBeUndefined();
  });

  it("learns the user mid-request, and ignores updates outside a request", () => {
    updateContext({ userId: "nobody" });
    expect(currentContext()).toBeUndefined();
    runWithContext({ requestId: "r-2" }, () => {
      updateContext({ userId: "u-1" });
      expect(currentContext()).toEqual({ requestId: "r-2", userId: "u-1" });
    });
  });

  it("puts only the ids it has on log lines, never personal data", () => {
    expect(contextLogFields()).toEqual({});
    runWithContext({ requestId: "r-3", locale: "es", timeZone: "Europe/Madrid" }, () => {
      expect(contextLogFields()).toEqual({ requestId: "r-3" });
    });
    runWithContext({ requestId: "r-4", userId: "u-1", orgId: "o-1", locale: "es" }, () => {
      expect(contextLogFields()).toEqual({ requestId: "r-4", userId: "u-1", orgId: "o-1" });
    });
  });
});
