/**
 * The single catalog of user-facing text for every surface.
 *
 * - Web (next-intl) and mobile (use-intl) load messages through an async loader.
 * - Servers (emails, push, SMS, in-app notifications) get a translator from
 *   `createI18n(source).getTranslator(locale)`, using the same ICU message format, so
 *   plurals, dates and numbers are formatted identically everywhere.
 *
 * Where messages come from is behind the `MessageSource` interface. Today the source
 * is the JSON bundled in this package (`bundledMessages`), so changing copy needs a
 * deploy. To edit copy without deploying, implement `MessageSource` over a database
 * table (e.g. `i18n.message(locale, key, value)`), cached in Redis and invalidated on
 * write, validate rows against English's shape before serving them, and pass it to
 * `createI18n` instead. Every caller is already async, so no call site changes.
 *
 * Adding a language: copy messages/en.json to messages/<code>.json, translate it, and
 * add the code to `locales` and `catalogs`. Every catalog is type-checked against
 * English, so a missing key fails `check-types` instead of rendering a raw key.
 */
import { createTranslator } from "use-intl/core";
import en from "../messages/en.json" with { type: "json" };
import es from "../messages/es.json" with { type: "json" };

export const locales = ["en", "es"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export type Messages = typeof en;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

/**
 * Picks the best supported locale from an `Accept-Language` header or a list of
 * preferences (`["es-MX", "en"]`), falling back to the default.
 */
export function negotiateLocale(
  preferences: string | readonly string[] | null | undefined,
): Locale {
  const list =
    typeof preferences === "string"
      ? preferences
          .split(",")
          .map((part) => part.split(";")[0]?.trim() ?? "")
          .filter(Boolean)
      : (preferences ?? []);
  for (const tag of list) {
    if (isLocale(tag)) return tag;
    const base = tag.split("-")[0];
    if (isLocale(base)) return base;
  }
  return defaultLocale;
}

/** Where translations are loaded from. See the module comment for the database variant. */
export interface MessageSource {
  load(locale: Locale): Promise<Messages>;
}

// `satisfies` makes every non-English catalog prove it has exactly English's shape.
const catalogs = { en, es: es satisfies Messages } satisfies Record<Locale, Messages>;

/** Messages shipped in this package. */
export const bundledMessages: MessageSource = {
  load: async (locale) => catalogs[locale],
};

export type Translator = ReturnType<typeof createTranslator<Messages>>;

/**
 * Server-side i18n over a message source, with a per-locale cache.
 *
 *   const i18n = createI18n(bundledMessages);
 *   const t = await i18n.getTranslator("es");
 *   t("email.otp.expires", { minutes: 5 }); // "Este código caduca en 5 minutos."
 */
export function createI18n(source: MessageSource) {
  const cache = new Map<Locale, Promise<Messages>>();

  const messagesFor = (locale: Locale) => {
    let pending = cache.get(locale);
    if (!pending) {
      pending = source.load(locale);
      // A failed load must not poison the cache; the next call retries.
      pending.catch(() => cache.delete(locale));
      cache.set(locale, pending);
    }
    return pending;
  };

  return {
    async getTranslator(locale: Locale, timeZone = "UTC"): Promise<Translator> {
      return createTranslator({ locale, messages: await messagesFor(locale), timeZone });
    },
    messages: messagesFor,
    /** Drop cached messages, e.g. after copy is edited in a database-backed source. */
    invalidate(locale?: Locale) {
      if (locale) cache.delete(locale);
      else cache.clear();
    },
  };
}

export type I18n = ReturnType<typeof createI18n>;
