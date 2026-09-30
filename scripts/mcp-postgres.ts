/**
 * Starts Claude Code's Postgres MCP server (.mcp.json) against the local `app` database,
 * as the local read-only role (infra/postgres/init/02-readonly-role.sql), on the port
 * this checkout's Postgres uses (.env, else .env.example's). When nothing listens there
 * it stops within a second and says what to do, instead of the server hanging past
 * Claude Code's 30-second start limit.
 */
import { ENV_EXAMPLE_PATH, ENV_PATH, listening, readEnv } from "./lib";

/** The local Postgres port: .env's, else the example's default. */
export function postgresPort(): number {
  const port =
    readEnv(ENV_PATH).get("POSTGRES_PORT") ?? readEnv(ENV_EXAMPLE_PATH).get("POSTGRES_PORT");
  return Number(port ?? 55432);
}

interface Server {
  exited: Promise<number>;
}
type Start = (
  command: string[],
  options: { env: Record<string, string | undefined>; stdio: ["inherit", "inherit", "inherit"] },
) => Server;

/** Runs the server until it exits; its exit code, or 1 when Postgres isn't up. */
export async function startServer(
  port = postgresPort(),
  start: Start = Bun.spawn,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  if (!(await listening(port))) {
    console.error(
      `Postgres isn't running on localhost:${port}. Start it with \`bun run db:up\`, then reconnect this server with /mcp.`,
    );
    return 1;
  }
  const server = start(
    ["uvx", "--with", "mcp==1.30.0", "postgres-mcp@0.3.0", "--access-mode=restricted"],
    {
      env: { ...env, DATABASE_URI: `postgresql://app_readonly:app_readonly@localhost:${port}/app` },
      stdio: ["inherit", "inherit", "inherit"],
    },
  );
  return server.exited;
}

if (import.meta.main) process.exit(await startServer());
