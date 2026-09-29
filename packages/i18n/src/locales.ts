/**
 * The supported languages and how one is picked, without the catalogs: what client
 * components (a language menu, a preference check) need, at no bundle cost. The
 * package's index re-exports all of it.
 */
export const locales = ["en", "es"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

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
