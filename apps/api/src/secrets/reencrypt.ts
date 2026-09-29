/**
 * Moves every encrypted value to the newest key, so older keys can be retired:
 * better-auth's values (OAuth tokens, 2FA secrets and backup codes, JWT signing keys) to
 * the newest BETTER_AUTH_SECRETS version, and webhook endpoint secrets to the active
 * ENCRYPTION_KEYS key. Run by `bun run --filter @repo/api secrets:reencrypt` (src/reencrypt.ts).
 *
 * Safe while the services run and safe to repeat: each row is written only if it still
 * holds the value that was read (a token refreshed meanwhile is left alone and is
 * already on the newest key), and values already on the newest key are skipped.
 */
import { type Database, tenantTx } from "@repo/db";
import type { SecretBox } from "@repo/nest-common";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { authEncryptionKey } from "../auth/secrets";

type AuthKey = ReturnType<typeof authEncryptionKey>;

export interface ReencryptResult {
  accounts: number;
  twoFactors: number;
  signingKeys: number;
  webhookEndpoints: number;
}

const PAGE = 200;

export async function reencryptSecrets(
  database: Database,
  { authKey, box }: { authKey: AuthKey; box: SecretBox },
): Promise<ReencryptResult> {
  const db = database.write;
  const result: ReencryptResult = {
    accounts: 0,
    twoFactors: 0,
    signingKeys: 0,
    webhookEndpoints: 0,
  };

  // Without versioned secrets there is one key, so better-auth's values are current.
  if (typeof authKey !== "string") {
    const current = `$ba$${authKey.currentVersion}$`;
    const onCurrent = (value: string) => value.startsWith(current);
    const refresh = async (value: string) =>
      onCurrent(value)
        ? value
        : symmetricEncrypt({
            key: authKey,
            data: await symmetricDecrypt({ key: authKey, data: value }),
          });

    for await (const account of pages((cursor) =>
      db.account.findMany({
        select: { id: true, accessToken: true, refreshToken: true, idToken: true },
        ...cursor,
      }),
    )) {
      const data: Record<string, string> = {};
      for (const field of ["accessToken", "refreshToken", "idToken"] as const) {
        const value = account[field];
        if (value && !onCurrent(value)) data[field] = await refresh(value);
      }
      if (Object.keys(data).length === 0) continue;
      const { count } = await db.account.updateMany({
        where: {
          id: account.id,
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          idToken: account.idToken,
        },
        data,
      });
      result.accounts += count;
    }

    for await (const row of pages((cursor) =>
      db.twoFactor.findMany({ select: { id: true, secret: true, backupCodes: true }, ...cursor }),
    )) {
      // Backup codes written before they were encrypted are a plain JSON array.
      const backupCodes = row.backupCodes.startsWith("[")
        ? await symmetricEncrypt({ key: authKey, data: row.backupCodes })
        : await refresh(row.backupCodes);
      const secret = await refresh(row.secret);
      if (secret === row.secret && backupCodes === row.backupCodes) continue;
      const { count } = await db.twoFactor.updateMany({
        where: { id: row.id, secret: row.secret, backupCodes: row.backupCodes },
        data: { secret, backupCodes },
      });
      result.twoFactors += count;
    }

    // Signing keys store the encrypted private key as a JSON string.
    for await (const key of pages((cursor) =>
      db.jwks.findMany({ select: { id: true, privateKey: true }, ...cursor }),
    )) {
      const encrypted = JSON.parse(key.privateKey) as string;
      if (onCurrent(encrypted)) continue;
      const { count } = await db.jwks.updateMany({
        where: { id: key.id, privateKey: key.privateKey },
        data: { privateKey: JSON.stringify(await refresh(encrypted)) },
      });
      result.signingKeys += count;
    }
  }

  // Webhook endpoints are tenant rows: each workspace's inside its own tenant context.
  for await (const org of pages((cursor) =>
    db.organization.findMany({ select: { id: true }, ...cursor }),
  )) {
    result.webhookEndpoints += await tenantTx(db, org.id, async (tx) => {
      let count = 0;
      const endpoints = await tx.webhookEndpoint.findMany({ select: { id: true, secret: true } });
      for (const endpoint of endpoints) {
        if (!box.needsRotation(endpoint.secret)) continue;
        const updated = await tx.webhookEndpoint.updateMany({
          where: { id: endpoint.id, secret: endpoint.secret },
          data: { secret: box.encrypt(box.decrypt(endpoint.secret)) },
        });
        count += updated.count;
      }
      return count;
    });
  }
  return result;
}

/** Every row of a table, a page at a time in id order. */
async function* pages<T extends { id: string }>(
  fetch: (cursor: {
    take: number;
    orderBy: { id: "asc" };
    cursor?: { id: string };
    skip?: number;
  }) => Promise<T[]>,
) {
  let after: string | undefined;
  for (;;) {
    const rows = await fetch({
      take: PAGE,
      orderBy: { id: "asc" },
      ...(after && { cursor: { id: after }, skip: 1 }),
    });
    yield* rows;
    if (rows.length < PAGE) return;
    after = rows.at(-1)?.id;
  }
}
