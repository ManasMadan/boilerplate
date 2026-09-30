import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkRepositories, prismaModels } from "./check-layers";
import { captureOutput } from "./stand-ins";

afterEach(() => mock.restore());

function tree(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "layers-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const schema = tree({
  "app.prisma": "model Todo {\n  id String @id\n}\n",
  "webhooks.prisma": "model WebhookEndpoint {\n  id String @id\n}\n",
});

describe("the repositories check", () => {
  it("names each model by its client accessor", () => {
    expect(prismaModels(schema).sort()).toEqual(["todo", "webhookEndpoint"]);
  });

  it("lets repositories query and services call them", () => {
    const printed = captureOutput();
    const modules = tree({
      "todo/todo.repository.ts": "tx.todo.findMany({});\ntx.$queryRaw`SELECT 1`;\n",
      "todo/todo.service.ts": "this.todos.create(tx, data);\nstripe.customers.create({});\n",
    });
    expect(checkRepositories(modules, schema)).toBe(0);
    expect(printed()).toContain("only repositories touch Prisma");
  });

  it("refuses model calls and raw SQL anywhere else", () => {
    const printed = captureOutput();
    const modules = tree({
      "todo/todo.service.ts": "await tx.todo.update({ where });\n",
      "webhooks/webhooks.service.ts": "withTenant(db, orgId)\n  .webhookEndpoint\n  .count();\n",
      "webhooks/raw.ts": "tx.$executeRaw`DELETE FROM x`;\n",
    });
    expect(checkRepositories(modules, schema)).toBe(1);
    const output = printed();
    expect(output).toContain("apps/api/src/modules/todo/todo.service.ts: queries Prisma directly");
    expect(output).toContain("apps/api/src/modules/webhooks/webhooks.service.ts");
    expect(output).toContain("apps/api/src/modules/webhooks/raw.ts");
  });

  it("passes the real API", () => {
    captureOutput();
    expect(checkRepositories()).toBe(0);
  });
});
