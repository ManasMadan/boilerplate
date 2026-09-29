/**
 * Notification channels and categories, shared by the notification service (what it may
 * send) and the apps (the preferences screen, rendering the inbox).
 *
 * Every template belongs to one category. Transactional categories (sign-in codes,
 * security alerts, invitations) always go out; the others can be turned off per
 * channel by each user. Adding a category: add it here with its default channels, give
 * it copy in packages/i18n (`notificationPreferences.categories.<name>`), and point
 * templates at it.
 */
import { z } from "zod";

export const notificationChannels = ["in_app", "email", "push", "sms"] as const;
export type NotificationChannel = (typeof notificationChannels)[number];

export const notificationCategories = {
  security: { mutable: false, channels: ["email", "sms"] },
  invitations: { mutable: false, channels: ["email"] },
  workspace: { mutable: true, channels: ["in_app", "email", "push"] },
  activity: { mutable: true, channels: ["in_app", "email", "push"] },
} as const satisfies Record<string, { mutable: boolean; channels: readonly NotificationChannel[] }>;
export type NotificationCategory = keyof typeof notificationCategories;

/** Categories users can change, with the channels they can change them on. */
export const mutableCategories = (
  Object.entries(notificationCategories) as [
    NotificationCategory,
    (typeof notificationCategories)[NotificationCategory],
  ][]
)
  .filter(([, category]) => category.mutable)
  .map(([name, category]) => ({ name, channels: category.channels }));

/**
 * In-app notification types and the data each carries. Apps render them from
 * packages/i18n (`notification.<type>.title` / `.body`, with the data as arguments).
 */
export const inAppNotifications = {
  "webhooks.endpoint-disabled": z.object({ endpointId: z.uuid(), url: z.string() }),
  "todo.reminder": z.object({ todoId: z.uuid(), title: z.string() }),
} as const;
export type InAppNotificationType = keyof typeof inAppNotifications;
