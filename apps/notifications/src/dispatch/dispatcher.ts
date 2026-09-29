/**
 * Delivers one notification: resolve recipients, then for each recipient and each
 * channel the template renders to (within its category's channels), claim the delivery,
 * apply the recipient's choices, and send.
 *
 *   - preferences: a mutable category turned off for a channel is skipped;
 *   - email: suppressed addresses are skipped; daily-digest users get non-urgent email
 *     in tomorrow's digest instead; opt-out-able email carries a one-click unsubscribe;
 *   - in_app: stored and pushed live to open tabs.
 *
 * Each (job, channel, recipient) is claimed in the delivery log first, so retries and
 * redelivered events never double-send. If any send fails, the job throws after trying
 * the others; its retry only redoes the failed ones.
 */
import { Injectable } from "@nestjs/common";
import { type NotificationChannel, notificationCategories } from "@repo/contracts/notifications";
import { withUser } from "@repo/db";
import { bundledMessages, createI18n } from "@repo/i18n";
import type { NotificationPayload } from "@repo/jobs";
import {
  createSignedTokens,
  type Database,
  InjectDatabase,
  InjectPinoLogger,
  PinoLogger,
} from "@repo/nest-common";
import { EmailChannel } from "../channels/email/email.channel";
import { InAppChannel } from "../channels/in-app/in-app.channel";
import { env } from "../env";
import { DeliveryLog } from "./delivery-log";
import { DeliveryPolicy, type UserPolicy } from "./policy";
import { type Recipient, RecipientResolver } from "./recipients";
import { type BoundTemplate, type RenderContext, TemplateSource } from "./templates";

@Injectable()
export class Dispatcher {
  private readonly i18n = createI18n(bundledMessages);
  private readonly tokens = createSignedTokens(env.UNSUBSCRIBE_SECRET);

  constructor(
    private readonly recipients: RecipientResolver,
    private readonly templates: TemplateSource,
    private readonly log: DeliveryLog,
    private readonly policy: DeliveryPolicy,
    private readonly email: EmailChannel,
    private readonly inApp: InAppChannel,
    @InjectDatabase() private readonly database: Database,
    @InjectPinoLogger(Dispatcher.name) private readonly logger: PinoLogger,
  ) {}

  async dispatch(payload: NotificationPayload, idempotencyKey: string) {
    const recipients = await this.recipients.resolve(payload.to);
    if (recipients.length === 0) {
      // Deleted between enqueue and delivery, or nobody has the role: nothing to send.
      this.logger.warn({ template: payload.template, idempotencyKey }, "no recipients, skipping");
      return;
    }
    const template = await this.templates.bind(payload);
    const failures: unknown[] = [];
    for (const recipient of recipients) {
      failures.push(
        ...(await this.deliverTo(recipient, payload.template, template, idempotencyKey)),
      );
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} deliveries failed; retrying those`);
    }
  }

  private async deliverTo(
    recipient: Recipient,
    name: string,
    template: BoundTemplate,
    idempotencyKey: string,
  ) {
    const category = notificationCategories[template.category];
    const policy = recipient.userId ? await this.policy.forUser(recipient.userId) : null;
    const t = await this.i18n.getTranslator(recipient.locale, recipient.timeZone);
    const unsubscribeUrl =
      category.mutable && recipient.userId
        ? this.unsubscribeUrl(recipient.userId, template.category)
        : undefined;
    const context: RenderContext = { recipient, t, unsubscribeUrl };
    const channels: readonly NotificationChannel[] = category.channels;
    const failures: unknown[] = [];

    for (const channel of channels) {
      if (!renders(template, channel)) continue;
      // Addresses without an account can only receive email.
      if (channel !== "email" && !recipient.userId) continue;
      const key = `${idempotencyKey}:${channel}:${recipient.userId ?? recipient.email}`;
      if (!(await this.log.claim(key, channel, name, recipient.userId))) continue;
      try {
        await this.send(channel, key, recipient, template, context, policy);
      } catch (error) {
        await this.log.finish(key, "failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        failures.push(error);
      }
    }
    return failures;
  }

  private async send(
    channel: NotificationChannel,
    key: string,
    recipient: Recipient,
    template: BoundTemplate,
    context: RenderContext,
    policy: UserPolicy | null,
  ) {
    if (policy && !policy.allows(template.category, channel)) {
      await this.log.finish(key, "skipped", { error: "turned off by the user" });
      return;
    }
    const { userId } = recipient;
    if (channel === "in_app" && template.inApp && userId) {
      const id = await this.inApp.send(userId, template.inApp());
      await this.log.finish(key, "sent", { providerMessageId: id });
      return;
    }
    if (channel === "email" && template.email) {
      if (await this.policy.isSuppressed("email", recipient.email)) {
        await this.log.finish(key, "suppressed");
        return;
      }
      // Daily-digest users get opt-out-able email in their next digest instead.
      if (policy?.dailyDigest && context.unsubscribeUrl && template.inApp && userId) {
        const message = template.inApp();
        await withUser(this.database.write, userId).notificationDigestItem.create({
          data: { userId, template: message.type, data: message.data },
        });
        await this.log.finish(key, "skipped", { error: "queued for the daily digest" });
        return;
      }
      const providerMessageId = await this.email.send(
        recipient.email,
        await template.email(context),
        key,
        context.unsubscribeUrl && userId
          ? this.listUnsubscribeHeaders(userId, template.category)
          : undefined,
      );
      await this.log.finish(key, "sent", { providerMessageId });
      return;
    }
    await this.log.finish(key, "skipped", { error: `no ${channel} channel configured` });
  }

  private unsubscribeToken(userId: string, category: string) {
    return this.tokens.sign("unsubscribe", [userId, category]);
  }

  private unsubscribeUrl(userId: string, category: string) {
    const url = new URL("/unsubscribe", env.WEB_URL);
    url.searchParams.set("token", this.unsubscribeToken(userId, category));
    return url.toString();
  }

  /** RFC 8058 one-click unsubscribe: mail clients POST to the URL, no page, no sign-in. */
  private listUnsubscribeHeaders(userId: string, category: string) {
    const url = new URL("/api/v1/notifications/unsubscribe", env.WEB_URL);
    url.searchParams.set("token", this.unsubscribeToken(userId, category));
    return {
      "List-Unsubscribe": `<${url.toString()}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }
}

function renders(template: BoundTemplate, channel: NotificationChannel) {
  switch (channel) {
    case "email":
      return template.email !== undefined;
    case "in_app":
      return template.inApp !== undefined;
    default:
      return false;
  }
}
