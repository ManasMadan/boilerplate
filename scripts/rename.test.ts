import { afterEach, describe, expect, it, mock } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityFrom, leftovers, main, rename, rewrite } from "./rename";
import { captureOutput } from "./stand-ins";

const ROOT = join(import.meta.dir, "..");
afterEach(() => mock.restore());

/** A git repository holding `files`. */
function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "rename-"));
  for (const [path, text] of Object.entries(files)) {
    writeFileSync(join(dir, path), text);
  }
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
  return dir;
}

const acme = identityFrom(["shop", "--owner", "Acme-Co", "--product", "Acme Shop"]);

describe("renaming the project", () => {
  it("rewrites every kind of identifier the template uses", () => {
    const lines = {
      "repoURL: https://github.com/ManasMadan/boilerplate.git":
        "repoURL: https://github.com/Acme-Co/shop.git",
      "image: ghcr.io/manasmadan/boilerplate/api": "image: ghcr.io/acme-co/shop/api",
      "* @ManasMadan": "* @Acme-Co",
      'bundleIdentifier: "com.boilerplate.app.development"':
        'bundleIdentifier: "com.shop.app.development"',
      'APNS_BUNDLE_ID: "dev.boilerplate.app"': 'APNS_BUNDLE_ID: "com.shop.app"',
      'appName: "Boilerplate"': 'appName: "Acme Shop"',
      "boilerplate.dev/component: api": "shop.dev/component: api",
      "http://boilerplate-webhooks.boilerplate.svc.cluster.local":
        "http://shop-webhooks.shop.svc.cluster.local",
      "EMAIL_FROM=no-reply@boilerplate.test": "EMAIL_FROM=no-reply@shop.test",
    };
    for (const [before, after] of Object.entries(lines)) {
      expect(rewrite(before, acme)).toBe(after);
    }
  });

  it("writes the product as given, `$` and all", () => {
    const pricey = identityFrom(["shop", "--owner", "me", "--product", "Shop $& $$ $1"]);
    expect(rewrite('appName: "Boilerplate"', pricey)).toBe('appName: "Shop $& $$ $1"');
  });

  it("derives the product and bundle id from the name", () => {
    expect(identityFrom(["my-app", "--owner", "me"])).toEqual({
      name: "my-app",
      owner: "me",
      product: "My-app",
      bundleId: "com.myapp.app",
    });
    expect(identityFrom(["x", "--owner", "me", "--bundle-id", "io.me.x"]).bundleId).toBe("io.me.x");
  });

  it.each([
    [["Shop", "--owner", "me"], /lowercase/],
    [["shop"], /--owner/],
    [["shop", "--owner", "me/you"], /--owner/],
    [["boilerplate", "--owner", "me"], /already/],
    [["shop", "--owner", "me", "--bundle-id", "shop"], /reverse DNS/],
  ])("refuses %j", (argv, message) => {
    expect(() => identityFrom(argv)).toThrow(message);
  });

  it("names every line still mentioning the template", () => {
    const files = new Map([
      ["a.md", "fine\nsee BOILERPLATE_TOKEN\nok"],
      ["b.ts", "// manasMadan"],
    ]);
    expect(leftovers(files)).toEqual(["a.md:2: see BOILERPLATE_TOKEN", "b.ts:1: // manasMadan"]);
  });

  it("leaves nothing of the template in a copy of this repository", () => {
    // A throwaway git repository with this checkout's tracked files.
    const dir = mkdtempSync(join(tmpdir(), "rename-"));
    const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT })
      .stdout.toString()
      .split("\0")
      .filter(Boolean);
    for (const path of tracked) {
      try {
        cpSync(join(ROOT, path), join(dir, path), { recursive: true });
      } catch {
        // Deleted in the working tree but still in the index: nothing to copy.
      }
    }
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
    writeFileSync(join(dir, "binary.bin"), Buffer.from([0, 1, 2, 0x62, 0x6f]));
    Bun.spawnSync(["git", "add", "binary.bin"], { cwd: dir });

    const { changed, left } = rename(dir, acme);
    expect(left).toEqual([]);
    expect(changed.length).toBeGreaterThan(50);
    expect(readFileSync(join(dir, "apps/mobile/app.config.ts"), "utf8")).toContain("com.shop.app");
    expect(readFileSync(join(dir, "binary.bin"))).toEqual(Buffer.from([0, 1, 2, 0x62, 0x6f]));
  }, 60_000);

  it("says what it did, and fails on what it couldn't rename", () => {
    const printed = captureOutput();
    expect(main(["shop", "--owner", "acme"], repo({ "a.md": "boilerplate" }))).toBe(0);
    expect(main(["shop", "--owner", "acme"], repo({ "a.md": "BOILERPLATE_KEY" }))).toBe(1);
    expect(main(["Shop", "--owner", "acme"], repo({}))).toBe(1);
    expect(printed()).toContain("1 files rewritten for acme/shop");
    expect(printed()).toContain("a.md:1: BOILERPLATE_KEY");
    expect(printed()).toContain("lowercase letters");
  });
});
