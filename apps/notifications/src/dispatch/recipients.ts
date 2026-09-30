import { Injectable } from "@nestjs/common";
import { defaultLocale, isLocale, type Locale, timeZoneOrUtc } from "@repo/i18n";
import type { NotificationPayload } from "@repo/jobs";
import { type Database, InjectDatabase } from "@repo/nest-common";

export interface Recipient {
  /** Null for an address without an account (an invitee, a number being verified). */
  userId: string | null;
  /** Null for a phone number being verified: text only. */
  email: string | null;
  /** A verified number to text, when the job names one. */
  phone: string | null;
  name: string | null;
  locale: Locale;
  timeZone: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  locale: string | null;
  timezone: string | null;
}

const toRecipient = (user: UserRow): Recipient => ({
  userId: user.id,
  email: user.email,
  phone: null,
  name: user.name,
  locale: isLocale(user.locale) ? user.locale : defaultLocale,
  timeZone: timeZoneOrUtc(user.timezone),
});

/**
 * Turns a job's `to` into deliverable recipients. Identity (email, name, locale) and
 * organization roles are owned by the auth schema; this service only reads them.
 */
@Injectable()
export class RecipientResolver {
  constructor(@InjectDatabase() private readonly database: Database) {}

  async resolve(to: NotificationPayload["to"]): Promise<Recipient[]> {
    if ("email" in to) {
      const phone = "phone" in to ? (to.phone ?? null) : null;
      return [
        { userId: null, email: to.email, phone, name: null, locale: to.locale, timeZone: "UTC" },
      ];
    }
    if ("phone" in to) {
      return [
        {
          userId: null,
          email: null,
          phone: to.phone,
          name: null,
          locale: to.locale,
          timeZone: "UTC",
        },
      ];
    }
    if ("userId" in to) {
      const user = await this.database.read.user.findUnique({
        where: { id: to.userId },
        select: { id: true, email: true, name: true, locale: true, timezone: true },
      });
      return user ? [toRecipient(user)] : [];
    }
    // Only these member columns are granted to this service (see the migration).
    const users = await this.database.read.$queryRaw<UserRow[]>`
      SELECT u.id, u.email, u.name, u.locale, u.timezone
      FROM auth.member m JOIN auth."user" u ON u.id = m.user_id
      WHERE m.organization_id = ${to.orgId}::uuid AND m.role = ANY(${to.roles}::text[])`;
    return users.map(toRecipient);
  }
}
