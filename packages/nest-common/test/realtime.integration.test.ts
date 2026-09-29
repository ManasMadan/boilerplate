/** RealtimeHub against the docker compose Valkey (private database). */
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRealtime } from "../src/realtime";
import { redisDatabase } from "../src/testing";

const message = z.discriminatedUnion("type", [
  z.object({ type: z.literal("todos.changed") }),
  z.object({ type: z.literal("notifications.changed") }),
]);
const { publish: publishRealtime, RealtimeHub } = createRealtime(message);
const redis = new Redis(redisDatabase(12), { maxRetriesPerRequest: null });
const hub = new RealtimeHub(redis);
afterAll(async () => {
  await hub.close();
  await redis.quit();
});

async function collect(channels: string[], count: number, publish: () => Promise<void>) {
  const controller = new AbortController();
  const received: unknown[] = [];
  const reading = (async () => {
    for await (const message of hub.stream(channels, controller.signal)) {
      received.push(message);
      if (received.length === count) controller.abort();
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 100)); // let SUBSCRIBE land
  await publish();
  await Promise.race([reading, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  controller.abort();
  await reading;
  return received;
}

describe("RealtimeHub", () => {
  it("delivers messages from every subscribed channel, and nothing else", async () => {
    const mine = `user:${randomUUID()}`;
    const team = `org:${randomUUID()}`;
    const received = await collect([mine, team], 2, async () => {
      await publishRealtime(redis, `org:${randomUUID()}`, { type: "todos.changed" });
      await publishRealtime(redis, team, { type: "todos.changed" });
      await publishRealtime(redis, mine, { type: "notifications.changed" });
    });
    expect(received).toEqual([{ type: "todos.changed" }, { type: "notifications.changed" }]);
  });

  it("unsubscribes from Redis when the last local stream ends", async () => {
    const channel = `user:${randomUUID()}`;
    await collect([channel], 1, () => publishRealtime(redis, channel, { type: "todos.changed" }));
    const [, subscribers] = (await redis.call("PUBSUB", "NUMSUB", `realtime:${channel}`)) as [
      string,
      number,
    ];
    expect(subscribers).toBe(0);
  });

  it("refuses to publish a message outside the contract", async () => {
    await expect(publishRealtime(redis, "user:x", { type: "nope" } as never)).rejects.toThrow();
  });
});
