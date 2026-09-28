import { Module } from "@nestjs/common";
import { env } from "../../env";
import { EmailChannel } from "./email.channel";
import {
  EMAIL_TRANSPORT,
  type EmailTransport,
  ResendTransport,
  SmtpTransport,
} from "./email-transport";

function createTransport(): EmailTransport {
  switch (env.EMAIL_PROVIDER) {
    case "resend":
      // Presence is checked at boot in env.ts.
      if (!env.RESEND_API_KEY)
        throw new Error("RESEND_API_KEY is required for EMAIL_PROVIDER=resend");
      return new ResendTransport(env.RESEND_API_KEY);
    case "smtp":
      return new SmtpTransport(env.SMTP_URL);
  }
}

@Module({
  providers: [{ provide: EMAIL_TRANSPORT, useFactory: createTransport }, EmailChannel],
  exports: [EmailChannel],
})
export class EmailModule {}
