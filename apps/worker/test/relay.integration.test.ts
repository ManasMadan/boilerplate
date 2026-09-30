/**
 * The outbox relay on its own, against a real (cloned) database, with an EventBus of the
 * test's own (the seam a log-based broker would fill): what it does when publishing
 * fails, when it can't listen, and when it's asked to drain while draining. The relay
 * inside the running worker is worker.integration.test.ts.
 */
import { createServer, type Server, type Socket } from "node:net";
import type { EventEnvelope } from "@repo/contracts/events";
import { createDatabase, type Database } from "@repo/db";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import type { PinoLogger } from "@repo/nest-common";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EventBus } from "../src/outbox/event-bus";
import type { OutboxRelay } from "../src/outbox/relay.service";

let testDb: TestDatabase;
let database: Database;

beforeAll(async () => {
  testDb = await createTestDatabase();
  Object.assign(process.env, {
    WORKER_DATABASE_URL: testDb.urlFor("app_worker"),
    WORKER_DATABASE_DIRECT_URL: testDb.urlFor("app_worker"),
  });
  database = createDatabase({ url: testDb.urlFor("app_worker"), poolMax: 2, service: "test" });
});
afterAll(async () => {
  await database?.disconnect();
  await testDb?.drop();
});

async function sql<T = Record<string, unknown>>(
  role: string,
  query: string,
  params: unknown[] = [],
) {
  const client = new pg.Client({ connectionString: testDb.urlFor(role) });
  await client.connect();
  try {
    return (await client.query(query, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** An event in the app's outbox, as apps/api writes one. */
async function emit() {
  const [row] = await sql<{ id: string }>(
    "app_api",
    `INSERT INTO app.outbox_event (name, key, payload, org_id)
     VALUES ('todo.created.v1', 'k', '{}', NULL) RETURNING id`,
  );
  return row?.id as string;
}

const published = async (id: string) =>
  (
    await sql<{ published_at: Date | null }>(
      "postgres",
      "SELECT published_at FROM app.outbox_event WHERE id = $1",
      [id],
    )
  )[0]?.published_at ?? null;

async function eventually<T>(fn: () => Promise<T> | T, done: (value: T) => boolean) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await fn();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** What the relay logged, by level and message. */
function recorder() {
  const logged: string[] = [];
  const log = {
    warn: (_fields: unknown, message: string) => logged.push(`warn: ${message}`),
    error: (_fields: unknown, message: string) => logged.push(`error: ${message}`),
  } as unknown as PinoLogger;
  return { logged, log };
}

/** A bus that records what it's given, or fails when `failing` says so. */
function bus(options: { failing?: boolean; hold?: Promise<void> } = {}) {
  const events: EventEnvelope[] = [];
  const instance = {
    events,
    async publish(batch: EventEnvelope[]) {
      await options.hold;
      if (options.failing) throw new Error("broker down");
      events.push(...batch);
    },
  };
  return instance as typeof instance & EventBus;
}

async function relayWith(eventBus: EventBus, log: PinoLogger): Promise<OutboxRelay> {
  const { OutboxRelay: Relay } = await import("../src/outbox/relay.service");
  return new Relay(database, eventBus, log);
}

const listeners = () =>
  sql<{ pid: number }>(
    "postgres",
    "SELECT pid FROM pg_stat_activity WHERE datname = $1 AND application_name = 'worker-outbox-listener'",
    [testDb.name],
  );

describe("outbox relay", () => {
  it("keeps what it couldn't hand on for the next pass, and does nothing once stopped", async () => {
    const id = await emit();
    const { logged, log } = recorder();
    const relay = await relayWith(bus({ failing: true }), log);
    relay.kick();
    await relay.onApplicationShutdown();
    expect(logged).toEqual(["error: outbox relay pass failed; retrying on next poll"]);
    expect(await published(id)).toBeNull();

    relay.kick();
    await relay.onApplicationShutdown();
    expect(logged).toHaveLength(1);
  });

  it("goes round again when asked to drain while it's draining", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recording = bus({ hold });
    const relay = await relayWith(recording, recorder().log);
    // The first pass takes whatever is waiting (including the last test's event) and
    // waits in publish; the event after it arrives meanwhile.
    relay.kick();
    const later = await emit();
    relay.kick();
    release();
    await eventually(
      () => recording.events.map((event) => event.id),
      (ids) => ids.includes(later),
    );
    await relay.onApplicationShutdown();
    expect(await published(later)).toBeInstanceOf(Date);
  });

  it("polls while it can't listen, and listens once it can", async () => {
    const recording = bus();
    const { logged, log } = recorder();
    const relay = await relayWith(recording, log);
    const connect = (verb: "GRANT" | "REVOKE") =>
      sql(
        "migrator",
        `${verb} CONNECT ON DATABASE ${testDb.name} ${verb === "GRANT" ? "TO" : "FROM"} app_worker`,
      );
    // The database refuses the worker's new connections for a moment.
    await connect("REVOKE");
    try {
      await relay.onApplicationBootstrap();
    } finally {
      await connect("GRANT");
    }
    expect(logged).toContain("warn: outbox listener could not connect; polling meanwhile");
    // A second or so later it tries again, and gets in.
    expect(await eventually(listeners, (rows) => rows.length === 1)).toHaveLength(1);
    const id = await emit();
    await eventually(
      () => recording.events.map((event) => event.id),
      (ids) => ids.includes(id),
    );
    await relay.onApplicationShutdown();
    expect(await eventually(listeners, (rows) => rows.length === 0)).toEqual([]);
  });

  it("doesn't come back to listen after it's been stopped mid-connect", async () => {
    // A database that takes the connection and never answers: connecting hangs.
    const sockets: Socket[] = [];
    const silent: Server = createServer((socket) => void sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as { port: number };
    vi.resetModules();
    vi.stubEnv("WORKER_DATABASE_DIRECT_URL", `postgresql://app_worker:x@127.0.0.1:${port}/app`);
    const { logged, log } = recorder();
    try {
      const relay = await relayWith(bus(), log);
      const booting = relay.onApplicationBootstrap();
      await eventually(
        () => sockets.length,
        (count) => count === 1,
      );
      await relay.onApplicationShutdown();
      // Now the connection fails: stopped, the relay doesn't schedule another.
      for (const socket of sockets) socket.destroy();
      await booting;
      await relay.onApplicationShutdown();
      expect(logged).toEqual(["warn: outbox listener could not connect; polling meanwhile"]);
    } finally {
      vi.unstubAllEnvs();
      await new Promise((resolve) => silent.close(resolve));
    }
  });
});
