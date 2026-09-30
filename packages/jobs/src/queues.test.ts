import { describe, expect, it } from "vitest";
import { eventSubscribers, queues } from "./queues";

describe("event routing", () => {
  it("sends the creation of a way into a workspace to the notification service", () => {
    const notifies = eventSubscribers["events-notifications"];
    expect(notifies("org.api_key_created.v1")).toBe(true);
    expect(notifies("webhook.endpoint_created.v1")).toBe(true);
    expect(notifies("todo.created.v1")).toBe(false);
  });

  it("sends notification requests to the notification service only, never to the audit log", () => {
    expect(eventSubscribers["events-notifications"]("notification.requested.v1")).toBe(true);
    expect(eventSubscribers["events-audit"]("notification.requested.v1")).toBe(false);
    expect(eventSubscribers["events-webhooks"]("notification.requested.v1")).toBe(false);
    expect(eventSubscribers["events-audit"]("todo.created.v1")).toBe(true);
  });

  it("retries with jitter, so jobs that failed together don't all come back at once", () => {
    for (const [name, queue] of Object.entries(queues)) {
      const backoff = queue.options.backoff as { type?: string; jitter?: number } | undefined;
      if (backoff?.type === "exponential") expect(backoff.jitter, name).toBeGreaterThan(0);
    }
  });
});
