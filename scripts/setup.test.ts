import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "./lib";
import { main, setup, syncEnv } from "./setup";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

function files(env?: string) {
  const dir = mkdtempSync(join(tmpdir(), "setup-"));
  const paths = { envPath: join(dir, ".env"), examplePath: join(dir, ".env.example") };
  writeFileSync(paths.examplePath, "PORT=3001\nAUTH_SECRET=change-me\nNEW=x\n");
  if (env !== undefined) writeFileSync(paths.envPath, env);
  return paths;
}

describe("setup", () => {
  it("creates .env with fresh secrets, then installs, starts, migrates and generates", () => {
    const printed = captureOutput();
    const paths = files();
    const { run, calls } = fakeRun();
    expect(setup({ run, ...paths })).toBe(0);
    const env = parseEnv(readFileSync(paths.envPath, "utf8"));
    expect(env.get("PORT")).toBe("3001");
    expect(env.get("AUTH_SECRET")).toMatch(/^[\w-]{43}$/);
    expect(printed()).toContain("Created .env from .env.example");
    expect(printed()).toContain("Generated AUTH_SECRET");
    expect(calls).toEqual([
      "bun install",
      "bun scripts/services.ts up",
      "bun run db:deploy",
      "bun run gen",
    ]);
    expect(printed()).toContain("Setup complete.");
  });

  it("keeps existing values and adds only what's missing", () => {
    captureOutput();
    const paths = files("PORT=4000\nAUTH_SECRET=mine\n");
    expect(setup({ run: fakeRun().run, ...paths })).toBe(0);
    expect(readFileSync(paths.envPath, "utf8")).toBe("PORT=4000\nAUTH_SECRET=mine\nNEW=x\n");
  });

  it("stops at the first step that fails, with its exit code", () => {
    const printed = captureOutput();
    const { run, calls } = fakeRun((line) =>
      line === "bun scripts/services.ts up" ? { status: 3 } : {},
    );
    expect(setup({ run, ...files("") })).toBe(3);
    expect(calls).toHaveLength(2);
    expect(printed()).not.toContain("Setup complete.");
    expect(setup({ run: fakeRun(() => ({ status: null })).run, ...files("") })).toBe(1);
  });

  it("syncs .env on its own, as bun dev does before starting", () => {
    captureOutput();
    const paths = files("PORT=4000\nAUTH_SECRET=change-me\n");
    const { run, calls } = fakeRun();
    expect(main(["--env"], { run, ...paths })).toBe(0);
    expect(calls).toEqual([]);
    const env = parseEnv(readFileSync(paths.envPath, "utf8"));
    expect(env.get("PORT")).toBe("4000");
    expect(env.get("NEW")).toBe("x");
    expect(env.get("AUTH_SECRET")).not.toBe("change-me");
  });

  it("runs the whole setup without --env, and syncs directly when asked", () => {
    captureOutput();
    const { run, calls } = fakeRun();
    expect(main([], { run, ...files() })).toBe(0);
    expect(calls).toHaveLength(4);
    const paths = files("");
    syncEnv(paths.envPath, paths.examplePath);
    expect(parseEnv(readFileSync(paths.envPath, "utf8")).get("NEW")).toBe("x");
  });
});
