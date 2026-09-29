/** The signed-in user's in-app notifications and what they choose to receive. */
import { z } from "zod";
import { inAppNotifications, notificationCategories, notificationChannels } from "../notifications";
import { page, pageInput } from "../pagination";
import { base } from "./base";

const inAppType = z.enum(
  Object.keys(inAppNotifications) as [
    keyof typeof inAppNotifications,
    ...(keyof typeof inAppNotifications)[],
  ],
);
const category = z.enum(
  Object.keys(notificationCategories) as [
    keyof typeof notificationCategories,
    ...(keyof typeof notificationCategories)[],
  ],
);

export const notificationSchema = z.object({
  id: z.uuid(),
  type: inAppType,
  /** Arguments for the type's copy (`notification.<type>.title` / `.body`). */
  data: z.record(z.string(), z.string()),
  /** Where it leads: a path on the web app. */
  link: z.string().nullable(),
  readAt: z.date().nullable(),
  createdAt: z.date(),
});
export type AppNotification = z.infer<typeof notificationSchema>;

/** Minutes after midnight in the user's time zone. */
const minuteOfDay = z.number().int().min(0).max(1439);

export const notificationPreferencesSchema = z.object({
  /** Every category users can change, with each channel's state. */
  categories: z.array(
    z.object({
      name: category,
      channels: z.array(z.object({ channel: z.enum(notificationChannels), enabled: z.boolean() })),
    }),
  ),
  dailyDigest: z.boolean(),
  /** Push and SMS wait until the end of quiet hours (both set, or neither). */
  quietHours: z.object({ start: minuteOfDay, end: minuteOfDay }).nullable(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

const route = (method: "GET" | "POST" | "PATCH", path: `/${string}`, summary: string) =>
  base.route({ method, path, tags: ["Notifications"], summary });

export const notificationsContract = {
  list: route("GET", "/notifications", "In-app notifications, newest first")
    .input(pageInput)
    .output(page(notificationSchema)),
  unreadCount: route("GET", "/notifications/unread-count", "How many are unread").output(
    z.object({ count: z.number().int() }),
  ),
  markRead: route("POST", "/notifications/read", "Mark notifications as read")
    .input(z.object({ ids: z.array(z.uuid()).min(1).max(100) }))
    .output(z.void()),
  markAllRead: route("POST", "/notifications/read-all", "Mark every notification as read").output(
    z.void(),
  ),
  preferences: route("GET", "/notifications/preferences", "What the user receives").output(
    notificationPreferencesSchema,
  ),
  updatePreferences: route("PATCH", "/notifications/preferences", "Change what the user receives")
    .input(
      z.object({
        channels: z
          .array(
            z.object({ category, channel: z.enum(notificationChannels), enabled: z.boolean() }),
          )
          .max(50)
          .optional(),
        dailyDigest: z.boolean().optional(),
        quietHours: z.object({ start: minuteOfDay, end: minuteOfDay }).nullable().optional(),
      }),
    )
    .output(notificationPreferencesSchema),
  /** From an email's unsubscribe link: no session, the signed token says who and what. */
  unsubscribe: route(
    "POST",
    "/notifications/unsubscribe-link",
    "Unsubscribe from a category's email",
  )
    .input(z.object({ token: z.string().min(10).max(1000) }))
    .output(z.object({ category })),
};
