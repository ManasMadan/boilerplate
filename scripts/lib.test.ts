import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envLine, parseEnv, removeEnvValue, writeEnvValue } from "./lib";

const dir = () => mkdtempSync(join(tmpdir(), "env-"));

/** What a runtime's own --env-file reads for KEY from a file holding `line`. */
function readBack(runtime: "node" | "bun", line: string) {
  const file = join(dir(), ".env");
  writeFileSync(file, `${line}\n`);
  const run = Bun.spawnSync(
    [runtime, `--env-file=${file}`, "-e", "process.stdout.write(process.env.KEY ?? '<unset>')"],
    {
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  return run.stdout.toString();
}

describe(".env values", () => {
  it.each([
    "plain-value_1.2:3/x",
    "sk_test_abc+/=",
    "has spaces and # a hash",
    'it"s "quoted"',
    "back\\slash",
    "two\nlines",
    "it's",
    "",
  ])("%j reads back unchanged in Node and in Bun", (value) => {
    const line = envLine("KEY", value);
    expect(readBack("node", line)).toBe(value);
    expect(readBack("bun", line)).toBe(value);
    expect(parseEnv(line).get("KEY")).toBe(value);
  });

  it("refuses what no spelling carries through both", () => {
    expect(() => envLine("KEY", "a$$b")).toThrow(/Bun expands/);
    expect(() => envLine("KEY", `it's "both"\nlines`)).toThrow(/both quotes/);
  });

  it("replaces a line in place, leaving the rest alone, and removes one", () => {
    const file = join(dir(), ".env");
    writeFileSync(file, "# comment\nA=1\nexport B=2\nAB=3\n");
    writeEnvValue(file, "A", "new value");
    writeEnvValue(file, "B", "x");
    writeEnvValue(file, "C", "added");
    expect(readFileSync(file, "utf8")).toBe("# comment\nA='new value'\nB=x\nAB=3\nC=added\n");
    expect(removeEnvValue(file, "AB")).toBe(true);
    expect(removeEnvValue(file, "AB")).toBe(false);
    expect(parseEnv(readFileSync(file, "utf8"))).toEqual(
      new Map([
        ["A", "new value"],
        ["B", "x"],
        ["C", "added"],
      ]),
    );
    expect(removeEnvValue(join(dir(), "missing"), "A")).toBe(false);
  });
});
