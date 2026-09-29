/**
 * The outbox relay: moves committed events from every service's outbox to the EventBus.
 *
 * Each pass claims up to RELAY_BATCH_SIZE unpublished rows with FOR UPDATE SKIP LOCKED,
 * publishes them, stamps published_at and commits. Any number of worker replicas can run
 * it at once: SKIP LOCKED gives each a different batch, so there's no leader to elect.
 * A crash after publishing but before the commit republishes the batch on the next pass;
 * the EventBus dedupes on the event id, so consumers still see each event once while its
 * job is kept (and are idempotent beyond that).
 *
 * It wakes on NOTIFY (sent by emitEvent when a transaction commits) through a direct,
 * non-pooled connection, and also polls every RELAY_POLL_INTERVAL_MS, so a lost
 * notification or a dropped listener only delays events, never loses them.
 *
 * Publishing happens inside the claiming transaction on purpose: the row locks are what
 * keep two relays from publishing the same batch. The transaction is short (one batch,
 * one Redis round trip) and has a timeout.
 *
 * At scale this is the OutboxSource seam: change data capture (logical replication or
 * Debezium reading the outbox tables) can replace polling and feed the same EventBus;
 * emitEvent and every consumer stay as they are.
 */
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { EventEnvelope } from "@repo/contracts/events";
import { Prisma } from "@repo/db";
import { type Database, InjectDatabase, InjectPinoLogger, PinoLogger } from "@repo/nest-common";
import pg from "pg";
import { env } from "../env";
import { EventBus } from "./event-bus";
import { OUTBOX_SOURCES, type OutboxSource } from "./sources";

interface OutboxRow {
  id: string;
  /** Possibly an event this build doesn't know yet (see eventEnvelope). */
  name: string;
  key: string;
  payload: unknown;
  org_id: string | null;
  actor_id: string | null;
  request_id: string | null;
  occurred_at: Date;
}

const RECONNECT_DELAY_MS = 2_000;

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private listener: pg.Client | undefined;
  private poller: NodeJS.Timeout | undefined;
  private reconnect: NodeJS.Timeout | undefined;
  private draining: Promise<void> | undefined;
  private rerun = false;
  private stopped = false;

  constructor(
    @InjectDatabase() private readonly database: Database,
    private readonly bus: EventBus,
    @InjectPinoLogger(OutboxRelay.name) private readonly log: PinoLogger,
  ) {}

  async onApplicationBootstrap() {
    await this.listen();
    this.poller = setInterval(() => this.kick(), env.RELAY_POLL_INTERVAL_MS);
    this.kick();
  }

  async onApplicationShutdown() {
    this.stopped = true;
    clearInterval(this.poller);
    clearTimeout(this.reconnect);
    await this.listener?.end().catch(() => undefined);
    // Let the batch in flight commit, so it isn't republished by the next replica.
    await this.draining;
  }

  /** Starts a drain, or asks the running one to go round again. Never runs two at once. */
  kick() {
    if (this.stopped) return;
    if (this.draining !== undefined) {
      this.rerun = true;
      return;
    }
    this.draining = this.drainAll().finally(() => {
      this.draining = undefined;
    });
  }

  /** Drains every source until nothing is left. Errors are logged; the next poll retries. */
  private async drainAll() {
    do {
      this.rerun = false;
      for (const source of OUTBOX_SOURCES) {
        try {
          let moved: number;
          do {
            moved = await this.drainBatch(source);
          } while (moved === env.RELAY_BATCH_SIZE && !this.stopped);
        } catch (error) {
          this.log.error({ err: error, source }, "outbox relay pass failed; retrying on next poll");
        }
      }
    } while (this.rerun && !this.stopped);
  }

  /** Publishes one batch from one source; returns how many events it moved. */
  async drainBatch(source: OutboxSource): Promise<number> {
    // The table name comes from the static source list, never from input.
    const table = Prisma.raw(`"${source}"."outbox_event"`);
    return this.database.write.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT id, name, key, payload, org_id, actor_id, request_id, occurred_at
          FROM ${table}
          WHERE published_at IS NULL
          ORDER BY occurred_at
          LIMIT ${env.RELAY_BATCH_SIZE}
          FOR UPDATE SKIP LOCKED`;
        if (rows.length === 0) return 0;
        await this.bus.publish(rows.map((row) => toEnvelope(row, source)));
        await tx.$executeRaw`
          UPDATE ${table} SET published_at = now()
          WHERE id = ANY(${rows.map((row) => row.id)}::uuid[])`;
        return rows.length;
      },
      { maxWait: 5_000, timeout: 15_000 },
    );
  }

  private async listen() {
    const client = new pg.Client({
      connectionString: env.WORKER_DATABASE_DIRECT_URL,
      application_name: "worker-outbox-listener",
    });
    client.on("notification", () => this.kick());
    client.on("error", (error) => {
      this.log.warn({ err: error }, "outbox listener lost its connection; reconnecting");
      this.scheduleReconnect();
    });
    try {
      await client.connect();
      await client.query("LISTEN outbox");
      this.listener = client;
    } catch (error) {
      this.log.warn({ err: error }, "outbox listener could not connect; polling meanwhile");
      await client.end().catch(() => undefined);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnect) return;
    const previous = this.listener;
    this.listener = undefined;
    void previous?.end().catch(() => undefined);
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.listen();
    }, RECONNECT_DELAY_MS);
  }
}

function toEnvelope(row: OutboxRow, source: OutboxSource): EventEnvelope {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    payload: row.payload,
    orgId: row.org_id,
    actorId: row.actor_id,
    requestId: row.request_id,
    occurredAt: row.occurred_at.toISOString(),
    source,
  };
}
