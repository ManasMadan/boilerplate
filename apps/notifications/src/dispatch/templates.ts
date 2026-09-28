/**
 * What each notification template renders to, per channel.
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
import {
  AuthOtpEmail,
  authOtpSubject,
  type RenderedEmail,
  renderEmail,
  TodoReminderEmail,
  todoReminderSubject,
} from "@repo/email";
import type { Translator } from "@repo/i18n";
import type { NotificationPayload, NotificationTemplate } from "@repo/jobs";
import type { Recipient } from "./recipients";

type PayloadOf<T extends NotificationTemplate> = Extract<NotificationPayload, { template: T }>;

export interface RenderContext {
  recipient: Recipient;
  t: Translator;
}

export interface TemplateDefinition<T extends NotificationTemplate> {
  email?: (payload: PayloadOf<T>, context: RenderContext) => Promise<RenderedEmail>;
  // push, sms and inApp renderers are added here as those channels land.
}

export type TemplateRegistry = { [T in NotificationTemplate]: TemplateDefinition<T> };

const templates = {
  "auth.otp": {
    email: (payload, { recipient, t }) =>
      renderEmail(AuthOtpEmail, authOtpSubject, { locale: recipient.locale, t, ...payload.data }),
  },
  "todo.reminder": {
    email: (payload, { recipient, t }) =>
      renderEmail(TodoReminderEmail, todoReminderSubject, {
        locale: recipient.locale,
        t,
        name: recipient.name ?? recipient.email,
        title: payload.data.title,
      }),
  },
} satisfies TemplateRegistry;

export abstract class TemplateSource {
  abstract get<T extends NotificationTemplate>(template: T): Promise<TemplateDefinition<T>>;
}

@Injectable()
export class CodeTemplateSource extends TemplateSource {
  async get<T extends NotificationTemplate>(template: T): Promise<TemplateDefinition<T>> {
    return (templates as TemplateRegistry)[template];
  }
}
