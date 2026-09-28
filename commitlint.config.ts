/**
 * Commit messages follow Conventional Commits (`feat(api): add todo sharing`), which
 * release-please turns into versions and the changelog. Scopes are the workspace
 * folder names, so history can be filtered per app or package.
 */
import type { UserConfig } from "@commitlint/types";

const config: UserConfig = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        "repo",
        "deps",
        "ci",
        "infra",
        "claude",
        "docs",
        "web",
        "mobile",
        "api",
        "webhooks",
        "notifications",
        "worker",
        "ai",
        "ui",
        "client",
        "contracts",
        "db",
        "email",
        "i18n",
        "jobs",
        "logger",
        "nest-common",
        "ai-client",
      ],
    ],
    "subject-case": [2, "never", ["upper-case", "pascal-case", "start-case"]],
    "body-max-line-length": [1, "always", 100],
  },
};

export default config;
