/**
 * Code generators: `bun run gen:new` picks one interactively, or name it and pass the
 * answers in order:
 *
 *   bun run gen:new api-feature --args projects project project '{"name":"Launch"}'
 *   bun run gen:new package --args money "Formatting and arithmetic for amounts of money."
 *
 * Each writes files that already pass lint, types, knip and their tests, wires them in,
 * and formats everything it touched; CI runs both into a scratch copy to keep it so
 * (scripts/generators.ts). The .claude/skills add-feature and add-package say what to do next.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PlopTypes } from "@turbo/gen";

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CAMEL = /^[a-z][a-zA-Z0-9]*$/;

export default function generator(plop: PlopTypes.NodePlopAPI): void {
  const root = plop.getDestBasePath();
  const run = (command: string, args: string[]) =>
    execFileSync(command, args, { cwd: root, stdio: "inherit" });

  // Rewrites the touched files the way `bun run format` would (import order included),
  // so an insertion never has to know where it sorts.
  const format =
    (paths: (answers: PlopTypes.Answers) => string[]): PlopTypes.CustomActionFunction =>
    (answers) => {
      const files = paths(answers);
      run("bunx", ["biome", "check", "--write", ...files]);
      return `formatted ${files.length} files`;
    };

  plop.setGenerator("api-feature", {
    description:
      "An API feature reading an existing tenant table: contract, apps/api module, client hook, integration test",
    prompts: [
      {
        type: "input",
        name: "name",
        message: "Feature name, kebab-case plural (the route and module), e.g. projects:",
        validate: (value: string) => {
          if (!KEBAB.test(value)) return "Use kebab-case, e.g. projects or time-entries";
          if (existsSync(join(root, "apps/api/src/modules", value))) return `${value} exists`;
          return true;
        },
      },
      {
        type: "input",
        name: "item",
        message: "One item, singular (names the schema and type), e.g. project:",
        default: (answers: PlopTypes.Answers) => String(answers.name).replace(/s$/, ""),
        validate: (value: string) => KEBAB.test(value) || "Use kebab-case, e.g. time-entry",
      },
      {
        type: "input",
        name: "model",
        message:
          "Prisma client accessor of its table (already in packages/db/prisma/schema, with org_id and RLS), e.g. project:",
        default: (answers: PlopTypes.Answers) => plop.getHelper("camelCase")(answers.item),
        validate: (value: string) => CAMEL.test(value) || "The camelCase accessor, e.g. timeEntry",
      },
      {
        type: "input",
        name: "row",
        message:
          'The columns a test row needs besides org_id, as JSON (the generated test inserts rows), e.g. {"name": "Launch"}:',
        default: "{}",
        validate: (value: string) => {
          try {
            const row: unknown = JSON.parse(value);
            return (
              (typeof row === "object" && row !== null && !Array.isArray(row)) || "A JSON object"
            );
          } catch {
            return 'A JSON object, e.g. {"name": "Launch"}';
          }
        },
      },
    ],
    actions: [
      {
        type: "add",
        path: "packages/contracts/src/api/{{kebabCase name}}.ts",
        templateFile: "templates/api-feature/contract.ts.hbs",
      },
      {
        type: "modify",
        path: "packages/contracts/src/api/index.ts",
        pattern: /(import \{ populateContractRouterPaths \} from "@orpc\/contract";\n)/,
        template: '$1import { {{camelCase name}}Contract } from "./{{kebabCase name}}";\n',
      },
      {
        type: "modify",
        path: "packages/contracts/src/api/index.ts",
        pattern: /(\n\}\);\n\nexport type Contract = typeof contract;\n\n)/,
        template:
          '\n  {{camelCase name}}: {{camelCase name}}Contract,$1export * from "./{{kebabCase name}}";\n',
      },
      {
        type: "add",
        path: "apps/api/src/modules/{{kebabCase name}}/index.ts",
        templateFile: "templates/api-feature/index.ts.hbs",
      },
      {
        type: "add",
        path: "apps/api/src/modules/{{kebabCase name}}/{{kebabCase name}}.module.ts",
        templateFile: "templates/api-feature/module.ts.hbs",
      },
      {
        type: "add",
        path: "apps/api/src/modules/{{kebabCase name}}/{{kebabCase name}}.repository.ts",
        templateFile: "templates/api-feature/repository.ts.hbs",
      },
      {
        type: "add",
        path: "apps/api/src/modules/{{kebabCase name}}/{{kebabCase name}}.service.ts",
        templateFile: "templates/api-feature/service.ts.hbs",
      },
      {
        type: "add",
        path: "apps/api/src/modules/{{kebabCase name}}/{{kebabCase name}}.router.ts",
        templateFile: "templates/api-feature/router.ts.hbs",
      },
      {
        type: "modify",
        path: "apps/api/src/app.module.ts",
        pattern: /(import \{ env \} from "\.\/env";\n)/,
        template: '$1import { {{pascalCase name}}Module } from "./modules/{{kebabCase name}}";\n',
      },
      {
        type: "modify",
        path: "apps/api/src/app.module.ts",
        pattern: /(\n {2}\],\n\}\)\nexport class AppModule)/,
        template: "\n    {{pascalCase name}}Module,$1",
      },
      {
        type: "modify",
        path: "apps/api/src/rpc/router.ts",
        pattern: /(import type \{ Procedures \} from "\.\/procedures";\n)/,
        template:
          'import { {{pascalCase name}}Service, {{camelCase name}}Router } from "../modules/{{kebabCase name}}";\n$1',
      },
      {
        type: "modify",
        path: "apps/api/src/rpc/router.ts",
        pattern: /(\n {2}\}\);\n\}\n\nexport type AppRouter)/,
        template:
          "\n    {{camelCase name}}: {{camelCase name}}Router(procedures, app.get({{pascalCase name}}Service)),$1",
      },
      {
        type: "add",
        path: "packages/client/src/api/{{kebabCase name}}/list.ts",
        templateFile: "templates/api-feature/client-list.ts.hbs",
      },
      {
        type: "append",
        path: "apps/api/test/api.integration.test.ts",
        templateFile: "templates/api-feature/integration-test.ts.hbs",
        // plop's uniqueness check turns the rendered test into an unescaped regular
        // expression, which `??` breaks; the module name is new (validated), so skip it.
        unique: false,
      },
      format(({ name }) => {
        const kebab = plop.getHelper("kebabCase")(name);
        return [
          `packages/contracts/src/api/${kebab}.ts`,
          "packages/contracts/src/api/index.ts",
          `apps/api/src/modules/${kebab}`,
          "apps/api/src/app.module.ts",
          "apps/api/src/rpc/router.ts",
          `packages/client/src/api/${kebab}`,
          "apps/api/test/api.integration.test.ts",
        ];
      }),
    ],
  });

  plop.setGenerator("package", {
    description: "A shared TypeScript package under packages/, consumed as source",
    prompts: [
      {
        type: "input",
        name: "name",
        message: "Package name, kebab-case (becomes @repo/<name> and a commit scope):",
        validate: (value: string) => {
          if (!KEBAB.test(value)) return "Use kebab-case, e.g. money";
          if (existsSync(join(root, "packages", value))) return `packages/${value} exists`;
          return true;
        },
      },
      {
        type: "input",
        name: "description",
        message: "One sentence: what it is for:",
        // It lands in package.json as is, so no quotes or backslashes.
        validate: (value: string) =>
          (value.trim().length > 0 && !/["\\]/.test(value)) ||
          "Say what the package is for, without quotes or backslashes",
      },
    ],
    actions: [
      {
        type: "add",
        path: "packages/{{kebabCase name}}/package.json",
        templateFile: "templates/package/package.json.hbs",
      },
      {
        type: "add",
        path: "packages/{{kebabCase name}}/tsconfig.json",
        templateFile: "templates/package/tsconfig.json.hbs",
      },
      {
        type: "add",
        path: "packages/{{kebabCase name}}/vitest.config.ts",
        templateFile: "templates/package/vitest.config.ts.hbs",
      },
      {
        type: "add",
        path: "packages/{{kebabCase name}}/src/index.ts",
        templateFile: "templates/package/index.ts.hbs",
      },
      {
        type: "modify",
        path: "commitlint.config.ts",
        pattern: /(\n\s*\],\n\s*\],\n\s*"subject-case")/,
        template: '\n        "{{kebabCase name}}",$1',
      },
      format(({ name }) => [
        `packages/${plop.getHelper("kebabCase")(name)}`,
        "commitlint.config.ts",
      ]),
      // Links the new workspace so other packages can depend on it.
      () => {
        run("bun", ["install"]);
        return "bun install";
      },
    ],
  });
}
