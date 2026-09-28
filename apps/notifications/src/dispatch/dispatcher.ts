import { Injectable } from "@nestjs/common";
import { bundledMessages, createI18n } from "@repo/i18n";
import type { NotificationPayload } from "@repo/jobs";
import { InjectPinoLogger, PinoLogger } from "@repo/nest-common";
import { EmailChannel } from "../channels/email/email.channel";
import { RecipientResolver } from "./recipients";
import { TemplateSource } from "./templates";

/**
 * Delivers one notification: resolve the recipient, render the template in their
 * language, send on every channel the template defines.
 *
 * `idempotencyKey` is the queue job id, stable across retries, so providers that
 * support idempotency never deliver the same message twice.
 */
@Injectable()
export class Dispatcher {
  private readonly i18n = createI18n(bundledMessages);

  constructor(
    private readonly recipients: RecipientResolver,
    private readonly templates: TemplateSource,
    private readonly email: EmailChannel,
    @InjectPinoLogger(Dispatcher.name) private readonly log: PinoLogger,
  ) {}

  async dispatch(payload: NotificationPayload, idempotencyKey: string) {
    const recipient = await this.recipients.resolve(payload.to);
    if (!recipient) {
      // The user was deleted between enqueue and delivery: nothing to send, not an error.
      this.log.warn(
        { template: payload.template, idempotencyKey },
        "recipient not found, skipping",
      );
      return;
    }

    const definition = await this.templates.get(payload.template);
    const t = await this.i18n.getTranslator(recipient.locale, recipient.timeZone);
    const context = { recipient, t };

    if (definition.email) {
      // The union narrows per template inside the registry; here it is one opaque call.
      const render = definition.email as (
        p: NotificationPayload,
        c: typeof context,
      ) => ReturnType<NonNullable<typeof definition.email>>;
      await this.email.send(
        recipient.email,
        await render(payload, context),
        `${idempotencyKey}:email`,
      );
    }
  }
}
