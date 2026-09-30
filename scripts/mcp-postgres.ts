/**
 * Starts Claude Code's Postgres MCP server (.mcp.json) against the local `app` database,
 * as the local read-only role (infra/postgres/init/02-readonly-role.sql), on the port
 * this checkout's Postgres uses (.env, else .env.example's). When nothing listens there
 * it stops within a second and says what to do, instead of the server hanging past
 * Claude Code's 30-second start limit.
 */
import { connect } from "node:net";
import { ENV_EXAMPLE_PATH, ENV_PATH, readEnv } from "./lib";

/** Whether something accepts connections on localhost:`port` within `timeoutMs`. */
export function listening(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** The local Postgres port: .env's, else the example's default. */
export function postgresPort(): number {
  const port =
    readEnv(ENV_PATH).get("POSTGRES_PORT") ?? readEnv(ENV_EXAMPLE_PATH).get("POSTGRES_PORT");
  return Number(port ?? 55432);
}

if (import.meta.main) {
  const port = postgresPort();
  if (!(await listening(port))) {
    console.error(
      `Postgres isn't running on localhost:${port}. Start it with \`bun run db:up\`, then reconnect this server with /mcp.`,
    );
    process.exit(1);
  }
  const server = Bun.spawn(
    ["uvx", "--with", "mcp==1.30.0", "postgres-mcp@0.3.0", "--access-mode=restricted"],
    {
      env: {
        ...process.env,
        DATABASE_URI: `postgresql://app_readonly:app_readonly@localhost:${port}/app`,
      },
      stdio: ["inherit", "inherit", "inherit"],
    },
  );
  process.exit(await server.exited);
}
