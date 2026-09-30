import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.json" with { type: "json" };
import { bundledMessages, createI18n, type MessageSource, negotiateLocale } from "./index";

describe("negotiateLocale", () => {
  it("picks exact, then base-language matches, then the default", () => {
    expect(negotiateLocale("es-MX,es;q=0.9,en;q=0.8")).toBe("es");
    expect(negotiateLocale(["fr-FR", "en-GB"])).toBe("en");
    expect(negotiateLocale("de")).toBe("en");
    expect(negotiateLocale(undefined)).toBe("en");
  });
});

describe("createI18n", () => {
  it("formats ICU plurals per locale", async () => {
    const i18n = createI18n(bundledMessages);
    expect((await i18n.getTranslator("en"))("email.otp.expires", { minutes: 1 })).toBe(
      "This code expires in 1 minute.",
    );
    expect((await i18n.getTranslator("es"))("email.otp.expires", { minutes: 5 })).toBe(
      "Este código caduca en 5 minutos.",
    );
  });

  it("caches per locale, retries after a failed load, and can be invalidated", async () => {
    const load = vi.fn<MessageSource["load"]>().mockRejectedValueOnce(new Error("db down"));
    load.mockImplementation(bundledMessages.load);
    const i18n = createI18n({ load });

    await expect(i18n.getTranslator("en")).rejects.toThrow("db down");
    await i18n.getTranslator("en");
    await i18n.getTranslator("en");
    expect(load).toHaveBeenCalledTimes(2);

    i18n.invalidate("en");
    await i18n.getTranslator("en");
    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe("catalog completeness", () => {
  it("has a translated message for every API error code", async () => {
    const { ERROR_CODES } = await import("@repo/contracts/errors");
    for (const locale of ["en", "es"] as const) {
      const messages = await bundledMessages.load(locale);
      for (const code of Object.keys(ERROR_CODES)) {
        expect(messages.errors, `${locale} is missing errors.${code}`).toHaveProperty(code);
      }
    }
  });

  it("asks for exactly the params an error code is declared with", async () => {
    const { ERROR_CODES, ERROR_PARAMS } = await import("@repo/contracts/errors");
    const messages = en.errors as Record<string, string>;
    // A message's top-level placeholders ({name}, {name, plural, …}), not the ones nested
    // inside a plural's branches.
    const placeholders = (message: string) => {
      const names = new Set<string>();
      let depth = 0;
      for (let i = 0; i < message.length; i++) {
        if (message[i] === "{") {
          if (depth === 0) names.add(/^\{\s*(\w+)/.exec(message.slice(i))?.[1] ?? "");
          depth++;
        } else if (message[i] === "}") depth--;
      }
      return [...names].filter(Boolean).sort();
    };
    for (const code of Object.keys(ERROR_CODES)) {
      const declared =
        code in ERROR_PARAMS
          ? Object.keys(ERROR_PARAMS[code as keyof typeof ERROR_PARAMS].shape).sort()
          : [];
      expect(placeholders(messages[code] ?? ""), code).toEqual(declared);
    }
  });

  it("describes every domain event in the audit log", async () => {
    const { eventNames, unauditedEvents } = await import("@repo/contracts/events");
    for (const locale of ["en", "es"] as const) {
      const i18n = createI18n(bundledMessages);
      const t = await i18n.getTranslator(locale);
      for (const name of eventNames.filter((event) => !unauditedEvents.has(event))) {
        const key = `workspace.audit.events.${name}` as Parameters<typeof t>[0];
        expect(t.has(key), `${locale} is missing workspace.audit.events.${name}`).toBe(true);
      }
    }
  });

  it("names every notification category and in-app notification type", async () => {
    const { inAppNotifications, notificationCategories } = await import(
      "@repo/contracts/notifications"
    );
    for (const locale of ["en", "es"] as const) {
      const t = await createI18n(bundledMessages).getTranslator(locale);
      for (const name of Object.keys(notificationCategories)) {
        const key = `notificationSettings.categories.${name}.title` as Parameters<typeof t>[0];
        expect(t.has(key), `${locale} is missing ${key}`).toBe(true);
      }
      for (const type of Object.keys(inAppNotifications)) {
        for (const part of ["title", "body"]) {
          const key = `notification.${type}.${part}` as Parameters<typeof t>[0];
          expect(t.has(key), `${locale} is missing ${key}`).toBe(true);
        }
      }
    }
  });

  it("labels every event customers can subscribe to", async () => {
    const { webhookEvents } = await import("@repo/contracts/events");
    for (const locale of ["en", "es"] as const) {
      const t = await createI18n(bundledMessages).getTranslator(locale);
      for (const name of webhookEvents) {
        const key = `workspace.webhooks.eventLabels.${name}` as Parameters<typeof t>[0];
        expect(t.has(key), `${locale} is missing workspace.webhooks.eventLabels.${name}`).toBe(
          true,
        );
      }
    }
  });
});
