/**
 * The JavaScript a browser downloads before a page can run (its first load), per route,
 * gzipped, against a budget: `bun run --cwd apps/web budget` after `next build` (CI runs
 * it after the end-to-end suite). A route over budget fails the run; so does the shared
 * part (what every route loads) growing past its own.
 *
 * Raise a budget only on purpose, in the same change that needs it, and say why. Most
 * growth is a dependency pulled into a client component that could stay on the server or
 * load lazily (`next/dynamic`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * Budgets in kB, gzipped: today's sizes plus a little room. A page with no forms loads
 * about 310 kB (React and Next are two thirds of it); pages with forms add up to about
 * 90 kB, mostly zod and react-hook-form. Two things keep it there: our packages declare
 * no side effects (so barrels only bring what's used), and code that reaches the browser
 * imports `* as z from "zod"` (biome refuses `import { z }`, which ships all of zod).
 */
const SHARED_BUDGET = 135;
const ROUTE_BUDGET = 410;

const NEXT = join(import.meta.dirname, "../.next");

interface ClientManifest {
  entryJSFiles?: Record<string, string[]>;
}

const sizes = new Map<string, number>();
function gzipped(file: string) {
  let size = sizes.get(file);
  if (size === undefined) {
    size = gzipSync(readFileSync(join(NEXT, file))).length;
    sizes.set(file, size);
  }
  return size;
}
const kB = (bytes: number) => bytes / 1024;
const total = (files: Iterable<string>) => kB([...files].reduce((sum, f) => sum + gzipped(f), 0));

/** Every route's client-reference manifest (server/app/**\/page_client-reference-manifest.js). */
function manifests(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return manifests(path);
    return entry.name === "page_client-reference-manifest.js" ? [path] : [];
  });
}

/** The manifest is a script assigning one JSON object: `globalThis.__RSC_MANIFEST[…] = {…};`. */
function parse(path: string): ClientManifest {
  const source = readFileSync(path, "utf8");
  const start = source.indexOf("= {");
  if (start === -1) throw new Error(`Unexpected manifest format: ${path}`);
  return JSON.parse(source.slice(start + 2, source.lastIndexOf("}") + 1)) as ClientManifest;
}

const build = JSON.parse(readFileSync(join(NEXT, "build-manifest.json"), "utf8")) as {
  rootMainFiles: string[];
};
const shared = new Set(build.rootMainFiles);
const sharedSize = total(shared);

const routes = manifests(join(NEXT, "server/app"))
  .map((path) => {
    const route = `/${relative(join(NEXT, "server/app"), path)}`
      .replace(/\/?page_client-reference-manifest\.js$/, "")
      .replace(/^$/, "/");
    const files = new Set([...shared, ...Object.values(parse(path).entryJSFiles ?? {}).flat()]);
    return { route: route || "/", size: total(files) };
  })
  .sort((a, b) => b.size - a.size);

if (routes.length === 0) throw new Error("No routes found: run `next build` first.");

let over = false;
const line = (label: string, size: number, budget: number) => {
  const failed = size > budget;
  over ||= failed;
  console.log(
    `  ${failed ? "✖" : "✔"} ${label.padEnd(48)} ${size.toFixed(1).padStart(7)} kB / ${budget} kB`,
  );
};
console.log("First-load JavaScript, gzipped:");
line("shared by every route", sharedSize, SHARED_BUDGET);
for (const { route, size } of routes) line(route, size, ROUTE_BUDGET);
if (over) {
  console.log("\nOver budget: see apps/web/scripts/bundle-budget.ts.");
  process.exit(1);
}
