import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AppError, runWithContext } from "@repo/nest-common";
import { describe, expect, it, vi } from "vitest";
import type { TodoService } from "../modules/todo";
import { createMcpServer } from "./mcp.server";

async function callListTodos(list: () => Promise<unknown>) {
  const logError = vi.fn();
  const server = createMcpServer(
    { userId: "u", orgId: "o", clientId: "c", scopes: new Set(["todos:read"]), token: "t" },
    {
      todos: { list } as unknown as TodoService,
      describeError: async (error) => `described ${error.code}`,
      logError,
      release: "test",
    },
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  const result = await runWithContext({ requestId: "req-1" }, () =>
    client.callTool({ name: "list_todos", arguments: { limit: 5 } }),
  );
  await client.close();
  return { result, logError };
}

describe("MCP tool failures", () => {
  it("tell the model what went wrong, for a known error", async () => {
    const { result, logError } = await callListTodos(async () => {
      throw new AppError("RATE_LIMITED", { params: { retryAfterSeconds: 3 } });
    });
    expect(result).toMatchObject({
      isError: true,
      content: [{ text: "RATE_LIMITED: described RATE_LIMITED" }],
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it("are logged, and reach the client as INTERNAL without any internals", async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'secret')");
    const { result, logError } = await callListTodos(async () => {
      throw bug;
    });
    expect(logError).toHaveBeenCalledWith(bug);
    expect(result).toMatchObject({ isError: true });
    const text = JSON.stringify(result);
    expect(text).toContain("INTERNAL: the tool failed");
    expect(text).not.toContain("secret");
  });
});
