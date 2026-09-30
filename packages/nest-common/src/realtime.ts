/**
 * Realtime fan-out over Redis pub/sub, for a message catalog (packages/contracts
 * realtime; plumbing stays free of domain types):
 *
 *   export const { publish, RealtimeHub } = createRealtime(realtimeMessage);   // once per service
 *   await publish(redis, realtimeChannel.org(orgId), { type: "todos.changed" }); // any service
 *   for await (const message of hub.stream([userChannel, orgChannel], signal)) yield message; // api
 *
 * Any service can publish. Each API process keeps one subscriber connection, subscribes
 * to a channel while at least one local stream wants it (reference-counted) and fans
 * messages out to those streams. Delivery is best effort (pub/sub has no replay):
 * messages only say "refetch", so a missed one costs freshness, never correctness, and
 * clients refetch whenever they reconnect.
 *
 * Seam: pub/sub on the shared Redis today. At very high fan-out, move to a dedicated
 * Redis (or NATS) by giving RealtimeHub and publishRealtime another connection; callers
 * don't change.
 */
import { EventEmitter } from "node:events";
import { REALTIME_REDIS_PREFIX } from "@repo/contracts/realtime";
import type { Redis } from "ioredis";
import type { z } from "zod";

// The Python service publishes on the same channels, named from this constant.
const PREFIX = REALTIME_REDIS_PREFIX;
/** Messages a slow stream may fall behind by before the oldest are dropped. */
const MAX_BUFFERED = 100;

export function createRealtime<S extends z.ZodType>(schema: S) {
  type Message = z.infer<S>;

  async function publish(redis: Redis, channel: string, message: Message) {
    await redis.publish(PREFIX + channel, JSON.stringify(schema.parse(message)));
  }

  class RealtimeHub {
    private readonly subscriber: Redis;
    private readonly local = new EventEmitter().setMaxListeners(0);
    private readonly refs = new Map<string, number>();

    constructor(redis: Redis) {
      // A connection in subscriber mode can't run other commands, so it gets its own.
      this.subscriber = redis.duplicate();
      this.subscriber.on("message", (channel: string, raw: string) => {
        const parsed = schema.safeParse(JSON.parse(raw));
        if (parsed.success) this.local.emit(channel.slice(PREFIX.length), parsed.data);
      });
    }

    /** Messages on these channels until `signal` aborts. */
    async *stream(channels: string[], signal: AbortSignal): AsyncGenerator<Message> {
      const buffer: Message[] = [];
      let wake: (() => void) | undefined;
      const onMessage = (message: Message) => {
        buffer.push(message);
        if (buffer.length > MAX_BUFFERED) buffer.shift();
        wake?.();
      };
      for (const channel of channels) this.local.on(channel, onMessage);
      await Promise.all(channels.map((channel) => this.retain(channel)));
      try {
        while (!signal.aborted) {
          if (buffer.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            wake = undefined;
          }
          while (buffer.length > 0 && !signal.aborted) yield buffer.shift() as Message;
        }
      } finally {
        for (const channel of channels) this.local.off(channel, onMessage);
        await Promise.all(channels.map((channel) => this.release(channel)));
      }
    }

    private async retain(channel: string) {
      const count = (this.refs.get(channel) ?? 0) + 1;
      this.refs.set(channel, count);
      if (count === 1) await this.subscriber.subscribe(PREFIX + channel);
    }

    private async release(channel: string) {
      const count = (this.refs.get(channel) ?? 1) - 1;
      if (count > 0) {
        this.refs.set(channel, count);
        return;
      }
      this.refs.delete(channel);
      await this.subscriber.unsubscribe(PREFIX + channel);
    }

    async close() {
      await this.subscriber.quit();
    }
  }

  return { publish, RealtimeHub };
}
