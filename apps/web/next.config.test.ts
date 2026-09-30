import { describe, expect, it } from "vitest";
import config from "./next.config";

describe("next.config headers", () => {
  it("serves the universal-links file as JSON, which iOS requires", async () => {
    const rules = (await config.headers?.()) ?? [];
    const rule = rules.find((r) => r.source === "/.well-known/apple-app-site-association");
    expect(rule?.headers).toContainEqual({ key: "Content-Type", value: "application/json" });
  });
});
