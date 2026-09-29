/**
 * What each notification template is (its category) and what it renders to, per channel.
 * A channel a template doesn't render to is never used for it; a category's channels
 * (packages/contracts notifications) cap what users can receive and turn off.
 *
 * Templates are defined in code today and reached only through `TemplateSource`, so
 * they can later be stored in the database (editable copy, per-tenant branding)
 * without touching the dispatcher: implement `TemplateSource` over a table, cache it
 * in Redis, and bind it instead of `CodeTemplateSource` in notifications.module.ts.
 *
 * Adding a template: add its payload to `notificationPayload` in packages/jobs, its
 * copy to packages/i18n, an email component to packages/email if it emails, then an
 * entry below. The `satisfies` clause makes a missing template a compile error.
 */
import { Injectable } from "@nestjs/common";
import type { InAppNotificationType, NotificationCategory } from "@repo/contracts/notifications";
import {
  AuthOtpEmail,
  authOtpSubject,
  OrgInvitationEmail,
  orgInvitationSubject,
  type RenderedEmail,
  renderEmail,
  SecurityAlertEmail,
  securityAlertSubject,
  TodoReminderEmail,
  todoReminderSubject,
  WebhookDisabledEmail,
  webhookDisabledSubject,
} from "@repo/email";
import type { Translator } from "@repo/i18n";
import type { NotificationPayload, NotificationTemplate } from "@repo/jobs";
import { env } from "../env";
import type { Recipient } from "./recipients";

type PayloadOf<T extends NotificationTemplate> = Extract<NotificationPayload, { template: T }>;

export interface RenderContext {
  recipient: Recipient;
  t: Translator;
  /** Present when the recipient may opt out of this email (mutable category, known user). */
  unsubscribeUrl?: string | undefined;
  /** The notification being delivered (for deferring a channel to later). */
  payload: NotificationPayload;
}

/** An in-app notification: rendered by the app from `notification.<type>` copy. */
export interface InAppMessage {
  type: InAppNotificationType;
  data: Record<string, string>;
  /** A path on the web app. */
  link?: string;
  orgId?: string;
}

export interface TemplateDefinition<T extends NotificationTemplate> {
  category: NotificationCategory;
  email?: (payload: PayloadOf<T>, context: RenderContext) => Promise<RenderedEmail>;
  inApp?: (payload: PayloadOf<T>) => InAppMessage;
  push?: (
    payload: PayloadOf<T>,
    context: RenderContext,
  ) => { title: string; body: string; link?: string };
  /** A text message: short, plain, no links a phisher could imitate. */
  sms?: (payload: PayloadOf<T>, context: RenderContext) => string;
}

export type TemplateRegistry = { [T in NotificationTemplate]: TemplateDefinition<T> };

const url = (path: string) => new URL(path, env.WEB_URL).toString();

const templates = {
  "auth.otp": {
    category: "security",
    email: (payload, { recipient, t }) =>
      renderEmail(AuthOtpEmail, authOtpSubject, { locale: recipient.locale, t, ...payload.data }),
  },
  "auth.phone-code": {
    category: "security",
    sms: (payload, { t }) =>
      t("sms.phoneCode", {
        code: payload.data.code,
        expiresInMinutes: payload.data.expiresInMinutes,
      }),
  },
  "auth.security-alert": {
    category: "security",
    email: (payload, { recipient, t }) =>
      renderEmail(SecurityAlertEmail, securityAlertSubject, {
        locale: recipient.locale,
        t,
        ...payload.data,
      }),
    sms: (payload, { t }) => t(`sms.securityAlert.${payload.data.event}`),
  },
  "org.invitation": {
    category: "invitations",
    email: (payload, { recipient, t }) =>
      renderEmail(OrgInvitationEmail, orgInvitationSubject, {
        locale: recipient.locale,
        t,
        ...payload.data,
      }),
  },
  "webhooks.endpoint-disabled": {
    category: "workspace",
    inApp: (payload) => ({
      type: "webhooks.endpoint-disabled",
      data: { endpointId: payload.data.endpointId, url: payload.data.url },
      link: `/settings/webhooks/${payload.data.endpointId}`,
      orgId: payload.to.orgId,
    }),
    email: (payload, { recipient, t, unsubscribeUrl }) =>
      renderEmail(WebhookDisabledEmail, webhookDisabledSubject, {
        locale: recipient.locale,
        t,
        url: payload.data.url,
        settingsUrl: url(`/settings/webhooks/${payload.data.endpointId}`),
        unsubscribeUrl,
      }),
    push: (payload, { t }) => ({
      title: t("notification.webhooks.endpoint-disabled.title"),
      body: t("notification.webhooks.endpoint-disabled.body", { url: payload.data.url }),
      link: `/settings/webhooks/${payload.data.endpointId}`,
    }),
  },
  "todo.reminder": {
    category: "activity",
    inApp: (payload) => ({
      type: "todo.reminder",
      data: { todoId: payload.data.todoId, title: payload.data.title },
      link: "/dashboard",
    }),
    email: (payload, { recipient, t, unsubscribeUrl }) =>
      renderEmail(TodoReminderEmail, todoReminderSubject, {
        locale: recipient.locale,
        t,
        name: recipient.name ?? recipient.email ?? "",
        title: payload.data.title,
        unsubscribeUrl,
      }),
    push: (payload, { t }) => ({
      title: t("notification.todo.reminder.title"),
      body: t("notification.todo.reminder.body", { title: payload.data.title }),
      link: "/dashboard",
    }),
  },
} satisfies TemplateRegistry;

/** A template with its payload applied: what the dispatcher works with. */
export interface BoundTemplate {
  category: NotificationCategory;
  email?: (context: RenderContext) => Promise<RenderedEmail>;
  inApp?: () => InAppMessage;
  push?: (context: RenderContext) => { title: string; body: string; link?: string };
  sms?: (context: RenderContext) => string;
}

/**
 * Pairs a definition with its payload. TypeScript can't relate `payload.template` to the
 * registry entry through the union, so that pairing is asserted here, once: the
 * registry is keyed by template and each payload was validated against its template.
 */
function bind<T extends NotificationTemplate>(
  definition: TemplateDefinition<T>,
  payload: PayloadOf<T>,
): BoundTemplate {
  return {
    category: definition.category,
    ...(definition.email && {
      email: (context: RenderContext) =>
        definition.email?.(payload, context) as Promise<RenderedEmail>,
    }),
    ...(definition.inApp && { inApp: () => definition.inApp?.(payload) as InAppMessage }),
    ...(definition.push && {
      push: (context: RenderContext) =>
        definition.push?.(payload, context) as ReturnType<NonNullable<BoundTemplate["push"]>>,
    }),
    ...(definition.sms && {
      sms: (context: RenderContext) => definition.sms?.(payload, context) as string,
    }),
  };
}

export abstract class TemplateSource {
  abstract bind(payload: NotificationPayload): Promise<BoundTemplate>;
}

@Injectable()
export class CodeTemplateSource extends TemplateSource {
  async bind(payload: NotificationPayload): Promise<BoundTemplate> {
    const definition = (templates as TemplateRegistry)[payload.template] as TemplateDefinition<
      typeof payload.template
    >;
    return bind(definition, payload as PayloadOf<typeof payload.template>);
  }
}
