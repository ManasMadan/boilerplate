/**
 * Email delivery providers behind one interface. Pick one with EMAIL_PROVIDER; add a
 * provider by implementing `EmailTransport` and registering it in email.module.ts.
 */
import type { RenderedEmail } from "@repo/email";
import nodemailer from "nodemailer";

export interface OutgoingEmail extends RenderedEmail {
  to: string;
  from: string;
  /** Lets receiving providers and our retries dedupe the same logical message. */
  idempotencyKey: string;
}

export interface EmailTransport {
  send(email: OutgoingEmail): Promise<{ providerMessageId: string }>;
}

export const EMAIL_TRANSPORT = Symbol("EMAIL_TRANSPORT");

export class SmtpTransport implements EmailTransport {
  private readonly transporter;

  constructor(url: string) {
    this.transporter = nodemailer.createTransport(url);
  }

  async send(email: OutgoingEmail) {
    const info = await this.transporter.sendMail({
      from: email.from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      messageId: `<${email.idempotencyKey}@notifications>`,
    });
    return { providerMessageId: info.messageId };
  }
}

export class ResendTransport implements EmailTransport {
  constructor(private readonly apiKey: string) {}

  async send(email: OutgoingEmail) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        // Resend drops a repeat send with the same key, so a retried job never double-sends.
        "Idempotency-Key": email.idempotencyKey,
      },
      body: JSON.stringify({
        from: email.from,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { id: string };
    return { providerMessageId: body.id };
  }
}
