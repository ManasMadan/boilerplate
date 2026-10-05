/**
 * Every image the Dockerfiles build from is pinned by digest as well as tag, so a tag
 * moved upstream can't change what an image is built from until Renovate proposes it.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "../deploy/docker");
const DIGEST = /@sha256:[0-9a-f]{64}$/;

/** The image references a Dockerfile names itself: its frontend, ARG defaults, FROMs. */
function references(text: string): string[] {
  const stages = [...text.matchAll(/^FROM .+ AS (\S+)$/gim)].map((m) => m[1]);
  return [
    ...[...text.matchAll(/^# syntax=(\S+)$/gm)].map((m) => m[1] as string),
    ...[...text.matchAll(/^ARG \w+_IMAGE=(\S+)$/gm)].map((m) => m[1] as string),
    ...[...text.matchAll(/^FROM (\S+)/gm)]
      .map((m) => m[1] as string)
      .filter((image) => !image.startsWith("${") && !stages.includes(image)),
  ];
}

describe("the Dockerfiles", () => {
  const files = readdirSync(DIR).filter((file) => file.endsWith(".Dockerfile"));

  it.each(files)("%s pins every image by digest", (file) => {
    const refs = references(readFileSync(join(DIR, file), "utf8"));
    expect(refs.length).toBeGreaterThan(1);
    for (const ref of refs) {
      expect({ ref, pinned: DIGEST.test(ref) }).toEqual({ ref, pinned: true });
    }
  });
});
