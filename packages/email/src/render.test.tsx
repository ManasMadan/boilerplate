import { bundledMessages, createI18n } from "@repo/i18n";
import { describe, expect, it } from "vitest";
import {
  AuthOtpEmail,
  authOtpSubject,
  renderEmail,
  SecurityAlertEmail,
  securityAlertSubject,
  TodoReminderEmail,
  todoReminderSubject,
} from "./index";

const i18n = createI18n(bundledMessages);

describe("renderEmail", () => {
  it("renders subject, html and text for the OTP email", async () => {
    const email = await renderEmail(AuthOtpEmail, authOtpSubject, {
      locale: "en",
      t: await i18n.getTranslator("en"),
      otp: "482913",
      purpose: "email-verification",
      expiresInMinutes: 5,
    });
    expect(email.subject).toBe("Verify your email");
    expect(email.html).toContain("482913");
    expect(email.html).toContain('lang="en"');
    expect(email.text).toContain("This code expires in 5 minutes.");
  });

  it("localizes every part", async () => {
    const email = await renderEmail(AuthOtpEmail, authOtpSubject, {
      locale: "es",
      t: await i18n.getTranslator("es"),
      otp: "482913",
      purpose: "forget-password",
      expiresInMinutes: 1,
    });
    expect(email.subject).toBe("Restablece tu contraseña");
    expect(email.html).toContain('lang="es"');
    expect(email.text).toContain("Este código caduca en 1 minuto.");
  });
});

describe("security alert", () => {
  it("names the new address and links to security settings", async () => {
    const email = await renderEmail(SecurityAlertEmail, securityAlertSubject, {
      locale: "en",
      t: await i18n.getTranslator("en"),
      event: "email-changed",
      newEmail: "new@example.com",
      securityUrl: "https://app.example/settings/security",
    });
    expect(email.subject).toBe("Your email address was changed");
    expect(email.text).toContain("new@example.com");
    expect(email.html).toContain("https://app.example/settings/security");
  });
});

describe("todo reminder", () => {
  it('greets by name, or without one when there\'s none (never "Hi ,")', async () => {
    const render = async (name: string | null) =>
      renderEmail(TodoReminderEmail, todoReminderSubject, {
        locale: "en",
        t: await i18n.getTranslator("en"),
        name,
        title: "Water the plants",
      });
    // The HTML: plain text renders headings in capitals.
    expect((await render("Ada")).html).toContain("Hi Ada,");
    const unnamed = (await render(null)).html;
    expect(unnamed).toContain("Hi,");
    expect(unnamed).not.toContain("Hi ,");
  });
});
