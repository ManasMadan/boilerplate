import { describe, expect, it } from "vitest";
import { createSignedTokens } from "./signed-token";

const tokens = createSignedTokens("a".repeat(32));

describe("signed tokens", () => {
  it("round-trips its parts", () => {
    expect(tokens.verify("unsubscribe", tokens.sign("unsubscribe", ["u1", "activity"]))).toEqual([
      "u1",
      "activity",
    ]);
  });

  it("rejects another purpose, another secret, or any edit", () => {
    const token = tokens.sign("unsubscribe", ["u1", "activity"]);
    expect(tokens.verify("delete-account", token)).toBeNull();
    expect(createSignedTokens("b".repeat(32)).verify("unsubscribe", token)).toBeNull();
    const [payload, signature] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify(["u2", "activity"])).toString("base64url")}.${signature}`;
    expect(tokens.verify("unsubscribe", forged)).toBeNull();
    expect(tokens.verify("unsubscribe", `${payload}.`)).toBeNull();
    expect(tokens.verify("unsubscribe", "garbage")).toBeNull();
  });

  it("refuses short secrets", () => {
    expect(() => createSignedTokens("short")).toThrow(/32 characters/);
  });
});
