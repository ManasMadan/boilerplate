import type { Locale, Messages } from "@repo/i18n";

// Makes `useTranslations()` keys and ICU arguments type-checked against the shared
// English catalog: a wrong key or missing argument fails to compile.
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
