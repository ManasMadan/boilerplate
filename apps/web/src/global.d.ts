import type { Locale, Messages } from "@repo/i18n";

// Makes `useTranslations()` keys type-checked against the shared English catalog: a
// wrong key fails to compile. ICU arguments aren't checked: the catalog is imported as
// JSON, so every message is typed `string`, and a missing argument shows only at runtime.
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
