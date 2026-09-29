import { Injectable } from "@nestjs/common";
import { defaultLocale, isLocale, type Locale } from "@repo/i18n";
import type { NotificationPayload } from "@repo/jobs";
import { type Database, InjectDatabase } from "@repo/nest-common";

export interface Recipient {
  /** Null for an address without an account (e.g. an invitee): email only. */
  userId: string | null;
  email: string;
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
  name: user.name,
  locale: isLocale(user.locale) ? user.locale : defaultLocale,
  timeZone: user.timezone ?? "UTC",
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
      return [{ userId: null, email: to.email, name: null, locale: to.locale, timeZone: "UTC" }];
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
