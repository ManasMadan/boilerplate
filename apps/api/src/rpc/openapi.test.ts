import { webhookEvents } from "@repo/contracts/events";
import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapi";

describe("the OpenAPI document", () => {
  it("describes the body of every event customers can subscribe to", async () => {
    const spec = await openApiDocument({ version: "1.0.0", serverUrl: "http://localhost" });
    expect(Object.keys(spec.webhooks ?? {}).sort()).toEqual([...webhookEvents].sort());
    expect(spec.webhooks?.["todo.created.v1"]).toMatchObject({
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/webhook.todo.created.v1" },
            },
          },
        },
      },
    });
    expect(spec.components?.schemas?.["webhook.todo.created.v1"]).toMatchObject({
      properties: { type: { const: "todo.created.v1" }, data: { required: ["todoId", "title"] } },
      required: ["type", "timestamp", "data"],
    });
    // Alongside the contract's own shared schemas, not instead of them.
    expect(spec.components?.schemas).toHaveProperty("ErrorData");
  });
});
