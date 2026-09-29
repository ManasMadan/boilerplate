/**
 * Delivers one notification: resolve recipients, then for each recipient and each
 * channel the template renders to (within its category's channels), claim the delivery,
 * apply the recipient's choices, and send.
 *
 *   - preferences: a mutable category turned off for a channel is skipped;
 *   - email: suppressed addresses are skipped; daily-digest users get non-urgent email
 *     in tomorrow's digest instead; opt-out-able email carries a one-click unsubscribe;
 *   - in_app: stored and pushed live to open tabs;
 *   - push: sent to each registered device; inside quiet hours it waits (a delayed job);
 *   - sms: security texts to a verified number; numbers that opted out (STOP) or can't
 *     receive texts are suppressed.
 *
 * Each (job, channel, recipient) is claimed in the delivery log first, so retries and
 * redelivered events never double-send. If any send fails, the job throws after trying
 * the others; its retry only redoes the failed ones.
 */

import { createHash } from "node:crypto";
import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { type NotificationChannel, notificationCategories } from "@repo/contracts/notifications";
import { withUser } from "@repo/db";
import { bundledMessages, createI18n } from "@repo/i18n";
import {
  createProducer,
  type NotificationPayload,
  type NotificationQueue,
  notificationQueue,
  type Producer,
} from "@repo/jobs";
import {
  createSignedTokens,
  type Database,
  InjectDatabase,
  InjectPinoLogger,
  InjectRedis,
  PinoLogger,
  type Redis,
} from "@repo/nest-common";
import { EmailChannel } from "../channels/email/email.channel";
import { InAppChannel } from "../channels/in-app/in-app.channel";
import { PushChannel } from "../channels/push/push.channel";
import { SmsChannel } from "../channels/sms/sms.channel";
import { env } from "../env";
import { DeliveryLog } from "./delivery-log";
import { DeliveryPolicy, type UserPolicy } from "./policy";
import { quietDelayMs } from "./quiet-hours";
import { type Recipient, RecipientResolver } from "./recipients";
import { type BoundTemplate, type RenderContext, TemplateSource } from "./templates";

@Injectable()
export class Dispatcher implements OnApplicationShutdown {
  private readonly i18n = createI18n(bundledMessages);
  private readonly tokens = createSignedTokens(env.UNSUBSCRIBE_SECRET);
  private readonly producers = new Map<NotificationQueue, Producer<NotificationQueue>>();

  constructor(
    private readonly recipients: RecipientResolver,
    private readonly templates: TemplateSource,
    private readonly log: DeliveryLog,
    private readonly policy: DeliveryPolicy,
    private readonly email: EmailChannel,
    private readonly inApp: InAppChannel,
    private readonly push: PushChannel,
    private readonly sms: SmsChannel,
    @InjectRedis() private readonly redis: Redis,
    @InjectDatabase() private readonly database: Database,
    @InjectPinoLogger(Dispatcher.name) private readonly logger: PinoLogger,
  ) {}

  async onApplicationShutdown() {
    await Promise.all([...this.producers.values()].map((producer) => producer.close()));
  }

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
      failures.push(...(await this.deliverTo(recipient, payload, template, idempotencyKey)));
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} deliveries failed; retrying those`);
    }
  }

  private async deliverTo(
    recipient: Recipient,
    payload: NotificationPayload,
    template: BoundTemplate,
    idempotencyKey: string,
  ) {
    const name = payload.template;
    const category = notificationCategories[template.category];
    const policy = recipient.userId ? await this.policy.forUser(recipient.userId) : null;
    const t = await this.i18n.getTranslator(recipient.locale, recipient.timeZone);
    const unsubscribeUrl =
      category.mutable && recipient.userId
        ? this.unsubscribeUrl(recipient.userId, template.category)
        : undefined;
    const context: RenderContext = { recipient, t, unsubscribeUrl, payload };
    const channels: readonly NotificationChannel[] = category.channels;
    const failures: unknown[] = [];

    for (const channel of channels) {
      if (!renders(template, channel) || !reaches(recipient, channel)) continue;
      const key = `${idempotencyKey}:${channel}:${recipient.userId ?? recipient.email ?? recipient.phone}`;
      if (channel === "push" && recipient.userId && template.push) {
        failures.push(
          ...(await this.deliverPush(recipient, name, template, context, policy, key, false)),
        );
        continue;
      }
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
      const id = await this.inApp.send(userId, template.inApp(context));
      await this.log.finish(key, "sent", { providerMessageId: id });
      return;
    }
    if (channel === "sms" && template.sms && recipient.phone) {
      await this.sendSms(key, recipient.phone, template.sms(context));
      return;
    }
    if (channel === "email" && template.email && recipient.email) {
      if (await this.policy.isSuppressed("email", recipient.email)) {
        await this.log.finish(key, "suppressed");
        return;
      }
      // Daily-digest users get opt-out-able email in their next digest instead.
      if (policy?.dailyDigest && context.unsubscribeUrl && template.inApp && userId) {
        const message = template.inApp(context);
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

  /** A transient failure throws (the job retries it); a permanent one is recorded. */
  private async sendSms(key: string, phone: string, body: string) {
    if (!this.sms.enabled) {
      await this.log.finish(key, "skipped", { error: "no SMS provider configured" });
      return;
    }
    if (await this.policy.isSuppressed("sms", phone)) {
      await this.log.finish(key, "suppressed");
      return;
    }
    const result = await this.sms.send(phone, body, key);
    if (result.ok) {
      await this.log.finish(key, "sent", { providerMessageId: result.providerMessageId });
    } else if (result.suppress) {
      await this.policy.suppress("sms", phone, result.suppress);
      await this.log.finish(key, "suppressed", { error: result.error });
    } else if (result.permanent) {
      await this.log.finish(key, "failed", { error: result.error });
    } else {
      throw new Error(result.error);
    }
  }

  /**
   * Push to each of the user's devices, each claimed separately. Inside the user's quiet
   * hours, nothing is claimed yet: one deferred job (deduplicated on the delivery key)
   * runs this again when they end.
   */
  private async deliverPush(
    recipient: Recipient,
    name: string,
    template: BoundTemplate,
    context: RenderContext,
    policy: UserPolicy | null,
    key: string,
    deferred: boolean,
  ) {
    const userId = recipient.userId as string;
    if (policy && !policy.allows(template.category, "push")) return [];
    const devices = await this.push.devices(userId);
    if (devices.length === 0 || !template.push) return [];

    const delay = deferred ? 0 : quietDelayMs(policy?.quietHours ?? null, recipient.timeZone);
    if (delay > 0) {
      await this.defer(context.payload, "push", userId, key, delay);
      return [];
    }
    const message = { ...template.push(context), collapseKey: name };
    const failures: unknown[] = [];
    for (const device of devices) {
      const deviceKey = `${key}:${device.id}`;
      if (!(await this.log.claim(deviceKey, "push", name, userId))) continue;
      const result = await this.push.send(userId, device, message);
      if (result.ok) {
        await this.log.finish(
          deviceKey,
          "sent",
          result.providerMessageId ? { providerMessageId: result.providerMessageId } : {},
        );
      } else if (result.gone) {
        await this.log.finish(deviceKey, "skipped", {
          error: `token no longer valid: ${result.error}`,
        });
      } else {
        await this.log.finish(deviceKey, "failed", { error: result.error });
        failures.push(new Error(result.error));
      }
    }
    return failures;
  }

  private async defer(
    payload: NotificationPayload,
    channel: "push",
    userId: string,
    key: string,
    delay: number,
  ) {
    const queue = notificationQueue[payload.template];
    let producer = this.producers.get(queue);
    if (!producer) {
      producer = createProducer(queue, this.redis);
      this.producers.set(queue, producer);
    }
    // Job ids can't contain ":", and the same deferral must only be queued once.
    const jobId = `deferred-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
    await producer.add("deferred", { payload, channel, userId, key }, { jobId, delay });
  }

  /** Runs a deferred channel delivery (quiet hours are over). */
  async deliverDeferred(
    payload: NotificationPayload,
    channel: "push",
    userId: string,
    key: string,
  ) {
    const [recipient] = await this.recipients.resolve({ userId });
    if (!recipient) return;
    const template = await this.templates.bind(payload);
    const policy = await this.policy.forUser(userId);
    const t = await this.i18n.getTranslator(recipient.locale, recipient.timeZone);
    const context: RenderContext = { recipient, t, payload };
    const failures =
      channel === "push"
        ? await this.deliverPush(recipient, payload.template, template, context, policy, key, true)
        : [];
    if (failures.length > 0)
      throw new AggregateError(failures, "deferred delivery failed; retrying");
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
    case "push":
      return template.push !== undefined;
    case "sms":
      return template.sms !== undefined;
  }
}

/** Whether the recipient has an address on this channel. */
function reaches(recipient: Recipient, channel: NotificationChannel) {
  switch (channel) {
    case "email":
      return recipient.email !== null;
    case "sms":
      return recipient.phone !== null;
    case "in_app":
    case "push":
      return recipient.userId !== null;
  }
}
