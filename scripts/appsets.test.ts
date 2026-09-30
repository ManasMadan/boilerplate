/**
 * The ApplicationSets in deploy/argocd/appsets, read from the files: what Argo CD can't
 * tell us until a cluster syncs them.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APPSETS = join(ROOT, "deploy/argocd/appsets");

type AppSetGenerator = Record<string, unknown> & {
  matrix?: { generators: AppSetGenerator[] };
  git?: { pathParamPrefix?: string; files?: { path: string }[] };
};

const appsets = readdirSync(APPSETS).map((file) => ({
  file,
  spec: (
    Bun.YAML.parse(readFileSync(join(APPSETS, file), "utf8")) as {
      spec: { generators: AppSetGenerator[] };
    }
  ).spec,
}));

type GitGenerator = NonNullable<AppSetGenerator["git"]>;

function* gitGenerators(generators: AppSetGenerator[]): Generator<GitGenerator> {
  for (const generator of generators) {
    if (generator.git) yield generator.git;
    if (generator.matrix) yield* gitGenerators(generator.matrix.generators);
  }
}

/** The files a git generator's glob (`dir/*.yaml`) matches. */
function matched(glob: string) {
  const dir = glob.slice(0, glob.lastIndexOf("/"));
  return readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => Bun.YAML.parse(readFileSync(join(ROOT, dir, name), "utf8")) as object);
}

describe("git file generators", () => {
  it("keep a file's own `path` key, which the generator's path parameter would replace", () => {
    for (const { file, spec } of appsets) {
      for (const git of gitGenerators(spec.generators)) {
        const clashes = (git.files ?? []).some((f) =>
          matched(f.path).some((values) => "path" in values),
        );
        if (clashes)
          expect({ file, prefix: git.pathParamPrefix }).toEqual({ file, prefix: "file" });
      }
    }
  });
});
