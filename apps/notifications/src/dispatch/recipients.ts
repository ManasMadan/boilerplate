import { Injectable } from "@nestjs/common";
import { defaultLocale, isLocale, type Locale } from "@repo/i18n";
import { type Database, InjectDatabase } from "@repo/nest-common";

export interface Recipient {
  email: string;
  name: string | null;
  locale: Locale;
  timeZone: string;
}

/**
 * Turns a job's `to` into a deliverable recipient. Identity (email, name, locale) is
 * owned by the auth schema; this service only reads it.
 */
@Injectable()
export class RecipientResolver {
  constructor(@InjectDatabase() private readonly database: Database) {}

  async resolve(
    to: { email: string; locale: Locale } | { userId: string },
  ): Promise<Recipient | null> {
    if ("email" in to) return { email: to.email, name: null, locale: to.locale, timeZone: "UTC" };

    const user = await this.database.read.user.findUnique({
      where: { id: to.userId },
      select: { email: true, name: true, locale: true, timezone: true },
    });
    if (!user) return null;
    return {
      email: user.email,
      name: user.name,
      locale: isLocale(user.locale) ? user.locale : defaultLocale,
      timeZone: user.timezone,
    };
  }
}
