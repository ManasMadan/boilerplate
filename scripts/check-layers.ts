/**
 * Layering rules that an import graph can't see, so dependency-cruiser can't check
 * them. In the API, only repositories touch Prisma: a service that queries a model
 * directly skips the one place that knows how the data is stored and scoped.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { fail, ok, ROOT } from "./lib";

const PRISMA_METHODS = [
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
];

/** The client's accessor for each model in the Prisma schema (`model WebhookEndpoint` is `webhookEndpoint`). */
export function prismaModels(schema: string): string[] {
  const models: string[] = [];
  for (const file of new Glob("*.prisma").scanSync(schema)) {
    for (const [, name = ""] of readFileSync(join(schema, file), "utf8").matchAll(
      /^model\s+(\w+)/gm,
    )) {
      models.push(name.charAt(0).toLowerCase() + name.slice(1));
    }
  }
  return models;
}

/** Reports each API module file other than a repository that queries Prisma; the exit code. */
export function checkRepositories(
  modules = join(ROOT, "apps/api/src/modules"),
  schema = join(ROOT, "packages/db/prisma/schema"),
): number {
  // `.todo.findMany(`, `.webhookEndpoint\n  .count(`, or raw SQL through `$queryRaw` and friends.
  const query = new RegExp(
    `\\.\\s*(?:${prismaModels(schema).join("|")})\\s*\\.\\s*(?:${PRISMA_METHODS.join("|")})\\s*\\(|\\$(?:query|execute)Raw`,
  );
  let violations = 0;
  for (const file of new Glob("**/*.{ts,tsx}").scanSync(modules)) {
    if (file.endsWith(".repository.ts")) continue;
    if (query.test(readFileSync(join(modules, file), "utf8"))) {
      violations += 1;
      fail(
        `apps/api/src/modules/${file}: queries Prisma directly; move the query into the module's repository.`,
      );
    }
  }
  if (violations) return 1;
  ok("only repositories touch Prisma");
  return 0;
}

if (import.meta.main) process.exit(checkRepositories());
