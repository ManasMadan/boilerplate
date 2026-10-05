import { expect, it } from "vitest";
import { register } from "./instrumentation";

it("starts a local site without the mobile app's identifiers", () => {
  // .env.example's WEB_URL is http://localhost; an https one would need them (app-links.test.ts).
  expect(() => register()).not.toThrow();
});
