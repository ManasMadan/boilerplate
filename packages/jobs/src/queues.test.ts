import { describe, expect, it } from "vitest";
import { eventSubscribers } from "./queues";

describe("event routing", () => {
  it("sends the creation of a way into a workspace to the notification service", () => {
    const notifies = eventSubscribers["events-notifications"];
    expect(notifies("org.api_key_created.v1")).toBe(true);
    expect(notifies("webhook.endpoint_created.v1")).toBe(true);
    expect(notifies("todo.created.v1")).toBe(false);
  });
});
