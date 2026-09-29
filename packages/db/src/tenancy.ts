/**
 * Tenant isolation, enforced by Postgres row-level security.
 *
 * Tenant tables have a policy that only exposes rows whose org_id equals the
 * transaction-local setting `app.org_id`. These helpers set it for every query:
 *
 *   const db = withTenant(database.read, orgId);
 *   await db.todo.findMany();                          // only this org's rows
 *
 *   await tenantTx(database.write, orgId, async (tx) => {
 *     await tx.todo.update(...);                        // state change ...
 *     await tx.appOutboxEvent.create(...);              // ... and its event, atomically
 *   });
 *
 * Why this shape: the setting must be applied inside the same transaction as the query,
 * because the pooler (PgBouncer, transaction mode) hands each transaction a different
 * server connection. `withTenant` sends each query as a two-statement batch, so no
 * connection is held between statements. Multi-statement units use `tenantTx`, an
 * interactive transaction that holds one connection until it ends, so it must contain
 * database calls only: never await HTTP, Redis or queues inside it.
 *
 * Nested `$transaction` on a tenant client is blocked: Prisma would run each operation
 * in its own transaction there, silently breaking atomicity.
 */
import type { Db } from "./client";
import type { Prisma } from "./generated/prisma/client";

const setTenant = (client: Db | Prisma.TransactionClient, orgId: string) =>
  client.$executeRaw`SELECT set_config('app.org_id', ${orgId}, true)`;

export function withTenant(db: Db, orgId: string) {
  return db.$extends({
    name: "tenant",
    client: {
      $transaction(): never {
        throw new Error("Use tenantTx() for multi-statement units on tenant data.");
      },
    },
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await db.$transaction([setTenant(db, orgId), query(args)], {
            maxWait: 10_000,
          });
          return result;
        },
      },
    },
  });
}

export type TenantDb = ReturnType<typeof withTenant>;

const setUser = (client: Db | Prisma.TransactionClient, userId: string) =>
  client.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;

/**
 * Like withTenant, for rows owned by one user rather than an organization (their
 * notifications, preferences, devices): row-level security on `app.user_id` scopes
 * every query to that user.
 */
export function withUser(db: Db, userId: string) {
  return db.$extends({
    name: "user",
    client: {
      $transaction(): never {
        throw new Error("Use userTx() for multi-statement units on per-user data.");
      },
    },
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await db.$transaction([setUser(db, userId), query(args)], {
            maxWait: 10_000,
          });
          return result;
        },
      },
    },
  });
}

/** Like tenantTx, for per-user data (see withUser). */
export function userTx<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await setUser(tx, userId);
    return fn(tx as Tx);
  }, TX_OPTIONS);
}

declare const txBrand: unique symbol;

/**
 * A client that is inside a database transaction. Only `tenantTx` and `transaction`
 * produce one, so APIs that must run inside a transaction (writing an outbox event
 * together with the change it describes) accept `Tx` and cannot be called with a plain
 * client: forgetting the transaction is a compile error, not a lost event.
 */
export type Tx = Prisma.TransactionClient & { readonly [txBrand]: true };

const TX_OPTIONS = { maxWait: 10_000, timeout: 5_000 } as const;

export function tenantTx<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await setTenant(tx, orgId);
    return fn(tx as Tx);
  }, TX_OPTIONS);
}

/** A transaction on non-tenant data (same rules as tenantTx: database calls only inside). */
export function transaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction((tx) => fn(tx as Tx), TX_OPTIONS);
}
