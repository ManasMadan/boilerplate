import { describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { listening, postgresPort } from "./mcp-postgres";

describe("the Postgres MCP server's start", () => {
  it("sees a port that accepts connections", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    expect(await listening(port)).toBe(true);
    server.close();
  });

  it("gives up on a closed port within its timeout", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    await new Promise((resolve) => server.close(resolve));
    const started = Date.now();
    expect(await listening(port, 500)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("uses a port from the environment files", () => {
    expect(Number.isInteger(postgresPort())).toBe(true);
  });
});
