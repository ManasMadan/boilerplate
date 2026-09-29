/**
 * Live streams for signed-in clients. A stream carries the user's channel and their
 * active workspace's (membership was checked by the inOrg procedure when it opened).
 *
 * Streams end after STREAM_LIFETIME_MS so the client reconnects and every check runs
 * again (session still valid, still a member). A user can hold MAX_STREAMS_PER_USER per
 * API process (a tab each), so one account can't exhaust connections.
 */
import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { realtimeChannel } from "@repo/contracts/realtime";
import { AppError, InjectRedis, type Redis } from "@repo/nest-common";
import { RealtimeHub } from "../../realtime";

const STREAM_LIFETIME_MS = 10 * 60_000;
const MAX_STREAMS_PER_USER = 10;

@Injectable()
export class RealtimeService implements OnApplicationShutdown {
  private readonly hub: InstanceType<typeof RealtimeHub>;
  private readonly open = new Map<string, number>();

  constructor(@InjectRedis() redis: Redis) {
    this.hub = new RealtimeHub(redis);
  }

  async *stream(userId: string, orgId: string, signal: AbortSignal | undefined) {
    const count = this.open.get(userId) ?? 0;
    if (count >= MAX_STREAMS_PER_USER) throw new AppError("RATE_LIMITED");
    this.open.set(userId, count + 1);

    const lifetime = AbortSignal.timeout(STREAM_LIFETIME_MS);
    const done = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
    try {
      yield* this.hub.stream([realtimeChannel.user(userId), realtimeChannel.org(orgId)], done);
    } finally {
      const remaining = (this.open.get(userId) ?? 1) - 1;
      if (remaining > 0) this.open.set(userId, remaining);
      else this.open.delete(userId);
    }
  }

  async onApplicationShutdown() {
    await this.hub.close();
  }
}
