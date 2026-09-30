/**
 * Adding a phone number: the user asks for a code, we text it, they type it back. Only
 * then is the number saved, so a stored number is always one the user receives texts at.
 *
 * This is our own flow rather than better-auth's phoneNumber plugin because the plugin's
 * `send-otp` endpoint needs no session (anyone can make us text any number) and it adds
 * password reset by SMS, which makes a phone number enough to take over an account.
 *
 *   - Codes are random, stored hashed in Redis with the number they were sent to, expire
 *     after PHONE_CODE_EXPIRES_IN and allow MAX_ATTEMPTS guesses.
 *   - Texts cost money and can be abused to spam a number (or to pump premium numbers),
 *     so sending needs a fresh session and is limited per user and per number.
 *   - Adding, changing or removing the number is audited and alerts the account's
 *     email (and the previous number, which is who needs to know it changed).
 */
import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { PHONE_CODE_EXPIRES_IN, PHONE_CODE_LENGTH } from "@repo/contracts/auth";
import { transaction } from "@repo/db";
import { isLocale, type Locale } from "@repo/i18n";
import {
  AppError,
  createRateLimiter,
  currentContext,
  type Database,
  InjectDatabase,
  InjectRedis,
  type Redis,
} from "@repo/nest-common";
import { env } from "../../env";
import { type CriticalNotifications, InjectCriticalNotifications } from "../../notifications";
import { emitEvent } from "../../outbox";

const MAX_ATTEMPTS = 5;
const MINUTE = 60;

interface PendingCode {
  phoneNumber: string;
  hash: string;
  attempts: number;
}

const codeKey = (userId: string) => `phone-code:${userId}`;
const hashCode = (userId: string, code: string) =>
  createHash("sha256").update(`${userId}:${code}`).digest("hex");

@Injectable()
export class PhoneService {
  private readonly perUser;
  private readonly perNumber;

  constructor(
    @InjectDatabase() private readonly database: Database,
    @InjectRedis() private readonly redis: Redis,
    @InjectCriticalNotifications() private readonly notifications: CriticalNotifications,
  ) {
    // Fail closed: without Redis, no texts go out.
    this.perUser = createRateLimiter(redis, {
      name: "phone-code-user",
      points: 5,
      windowSeconds: 60 * MINUTE,
      onRedisError: "deny",
    });
    this.perNumber = createRateLimiter(redis, {
      name: "phone-code-number",
      points: 3,
      windowSeconds: 60 * MINUTE,
      onRedisError: "deny",
    });
  }

  async current(userId: string) {
    const user = await this.database.read.user.findUnique({
      where: { id: userId },
      select: { phoneNumber: true },
    });
    return user?.phoneNumber ?? null;
  }

  async sendCode(userId: string, locale: string | null | undefined, phoneNumber: string) {
    const current = await this.database.read.user.findUnique({
      where: { id: userId },
      select: { phoneNumber: true },
    });
    if (current?.phoneNumber === phoneNumber) throw new AppError("PHONE_NUMBER_TAKEN");
    const taken = await this.database.read.user.findUnique({
      where: { phoneNumber },
      select: { id: true },
    });
    if (taken) throw new AppError("PHONE_NUMBER_TAKEN");

    for (const [limiter, key] of [
      [this.perUser, userId],
      [this.perNumber, phoneNumber],
    ] as const) {
      const result = await limiter.consume(key);
      if (!result.allowed) {
        throw new AppError("RATE_LIMITED", {
          params: { retryAfterSeconds: result.retryAfterSeconds },
        });
      }
    }

    const code = String(randomInt(0, 10 ** PHONE_CODE_LENGTH)).padStart(PHONE_CODE_LENGTH, "0");
    const pending: PendingCode = { phoneNumber, hash: hashCode(userId, code), attempts: 0 };
    // A new code replaces the previous one.
    await this.redis.set(codeKey(userId), JSON.stringify(pending), "EX", PHONE_CODE_EXPIRES_IN);
    await this.notifications.add(
      "send",
      {
        template: "auth.phone-code",
        to: { phone: phoneNumber, locale: isLocale(locale) ? locale : "en" },
        data: { code, expiresInMinutes: Math.round(PHONE_CODE_EXPIRES_IN / MINUTE) },
      },
      { jobId: randomUUID(), meta: jobMeta() },
    );
    return { expiresInSeconds: PHONE_CODE_EXPIRES_IN };
  }

  async verify(userId: string, phoneNumber: string, code: string) {
    const key = codeKey(userId);
    const raw = await this.redis.get(key);
    const pending = raw ? (JSON.parse(raw) as PendingCode) : null;
    if (!pending || pending.phoneNumber !== phoneNumber) throw new AppError("PHONE_CODE_INVALID");
    const matches = timingSafeEqual(
      Buffer.from(pending.hash, "hex"),
      Buffer.from(hashCode(userId, code), "hex"),
    );
    if (!matches) {
      pending.attempts += 1;
      if (pending.attempts >= MAX_ATTEMPTS) await this.redis.del(key);
      else await this.redis.set(key, JSON.stringify(pending), "KEEPTTL");
      throw new AppError("PHONE_CODE_INVALID");
    }
    // One use only, even if two requests race with the right code.
    if ((await this.redis.del(key)) === 0) throw new AppError("PHONE_CODE_INVALID");
    return this.change(userId, phoneNumber);
  }

  remove(userId: string) {
    return this.change(userId, null);
  }

  private async change(userId: string, phoneNumber: string | null) {
    const { previous, user } = await transaction(this.database.write, async (tx) => {
      const before = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { phoneNumber: true },
      });
      const updated = await tx.user
        .update({ where: { id: userId }, data: { phoneNumber } })
        .catch((error: { code?: string }) => {
          // Someone else verified this number in the meantime.
          if (error.code === "P2002") throw new AppError("PHONE_NUMBER_TAKEN");
          throw error;
        });
      if (before.phoneNumber !== phoneNumber) {
        await emitEvent(
          tx,
          "auth.phone_changed.v1",
          userId,
          { userId, change: phoneNumber ? "added" : "removed" },
          { actorId: userId, orgId: null },
        );
      }
      return { previous: before.phoneNumber, user: updated };
    });
    if (previous !== phoneNumber && (phoneNumber || previous)) {
      await this.notifications.add(
        "send",
        {
          template: "auth.security-alert",
          to: {
            email: user.email,
            locale: (isLocale(user.locale) ? user.locale : "en") as Locale,
            // The number that was on the account: after a change, the old one hears of it.
            ...((previous ?? phoneNumber) && { phone: (previous ?? phoneNumber) as string }),
          },
          data: {
            event: phoneNumber ? "phone-added" : "phone-removed",
            securityUrl: new URL("/settings/security", env.WEB_URL).toString(),
          },
        },
        { jobId: randomUUID(), meta: jobMeta() },
      );
    }
    return user;
  }
}

function jobMeta() {
  const context = currentContext();
  return {
    ...(context?.requestId && { requestId: context.requestId }),
    ...(context?.userId && { userId: context.userId }),
  };
}
