import { describe, expect, it, vi } from "vitest";
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
