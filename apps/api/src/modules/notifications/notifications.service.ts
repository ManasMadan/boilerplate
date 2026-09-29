/**
 * The signed-in user's inbox and delivery choices (notifications schema; apps/api may
 * read the inbox, mark it read, and edit preferences and settings). Every query is
 * scoped to the user by row-level security (withUser / userTx).
 */
import { Injectable } from "@nestjs/common";
import type { AppNotification, NotificationPreferences } from "@repo/contracts/api";
import {
  type InAppNotificationType,
  mutableCategories,
  type NotificationCategory,
  type NotificationChannel,
  notificationCategories,
} from "@repo/contracts/notifications";
import { type PageInput, toPage } from "@repo/contracts/pagination";
import { realtimeChannel } from "@repo/contracts/realtime";
import { userTx, withUser } from "@repo/db";
import {
  AppError,
  createSignedTokens,
  type Database,
  InjectDatabase,
  InjectRedis,
  type Redis,
} from "@repo/nest-common";
import { env } from "../../env";
import { publishRealtime } from "../../realtime";

export interface PreferenceChanges {
  channels?:
    | { category: NotificationCategory; channel: NotificationChannel; enabled: boolean }[]
    | undefined;
  dailyDigest?: boolean | undefined;
  quietHours?: { start: number; end: number } | null | undefined;
}

@Injectable()
export class NotificationsService {
  private readonly tokens = createSignedTokens(env.UNSUBSCRIBE_SECRET);

  constructor(
    @InjectDatabase() private readonly database: Database,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async list(userId: string, { limit, cursor }: PageInput) {
    const rows = await withUser(this.database.read, userId).notification.findMany({
      where: { userId, ...(cursor && { id: { lt: cursor } }) },
      orderBy: { id: "desc" },
      take: limit + 1,
      select: { id: true, template: true, data: true, link: true, readAt: true, createdAt: true },
    });
    const items: AppNotification[] = rows.map((row) => ({
      id: row.id,
      type: row.template as InAppNotificationType,
      data: (row.data ?? {}) as Record<string, string>,
      link: row.link,
      readAt: row.readAt,
      createdAt: row.createdAt,
    }));
    return toPage(items, limit);
  }

  async unreadCount(userId: string) {
    const count = await withUser(this.database.read, userId).notification.count({
      where: { userId, readAt: null },
    });
    return { count };
  }

  async markRead(userId: string, ids?: string[]) {
    await withUser(this.database.write, userId).notification.updateMany({
      where: { userId, readAt: null, ...(ids && { id: { in: ids } }) },
      data: { readAt: new Date() },
    });
    // The user's other tabs and devices update their badge.
    await publishRealtime(this.redis, realtimeChannel.user(userId), {
      type: "notifications.changed",
    });
  }

  async preferences(userId: string): Promise<NotificationPreferences> {
    const scoped = withUser(this.database.read, userId);
    const [rows, settings] = await Promise.all([
      scoped.notificationPreference.findMany({
        where: { userId },
        select: { category: true, channel: true, enabled: true },
      }),
      scoped.notificationSettings.findUnique({
        where: { userId },
        select: { quietStart: true, quietEnd: true, dailyDigest: true },
      }),
    ]);
    const saved = new Map(rows.map((row) => [`${row.category}:${row.channel}`, row.enabled]));
    return {
      categories: mutableCategories.map(({ name, channels }) => ({
        name,
        channels: channels.map((channel) => ({
          channel,
          enabled: saved.get(`${name}:${channel}`) ?? true,
        })),
      })),
      dailyDigest: settings?.dailyDigest ?? false,
      quietHours:
        settings?.quietStart != null && settings.quietEnd != null
          ? { start: settings.quietStart, end: settings.quietEnd }
          : null,
    };
  }

  async updatePreferences(userId: string, changes: PreferenceChanges) {
    for (const { category, channel } of changes.channels ?? []) {
      const known = notificationCategories[category];
      // Transactional email can't be turned off, and only a category's own channels exist.
      if (!known.mutable || !(known.channels as readonly string[]).includes(channel)) {
        throw new AppError("VALIDATION_FAILED", { params: { category, channel } });
      }
    }
    await userTx(this.database.write, userId, async (tx) => {
      for (const { category, channel, enabled } of changes.channels ?? []) {
        await tx.notificationPreference.upsert({
          where: { userId_category_channel: { userId, category, channel } },
          create: { userId, category, channel, enabled },
          update: { enabled },
        });
      }
      if (changes.dailyDigest !== undefined || changes.quietHours !== undefined) {
        const settings = {
          ...(changes.dailyDigest !== undefined && { dailyDigest: changes.dailyDigest }),
          ...(changes.quietHours !== undefined && {
            quietStart: changes.quietHours?.start ?? null,
            quietEnd: changes.quietHours?.end ?? null,
          }),
        };
        await tx.notificationSettings.upsert({
          where: { userId },
          create: { userId, ...settings },
          update: settings,
        });
      }
    });
    return this.preferences(userId);
  }

  /** Turns off a category's email for the user a signed unsubscribe link names. */
  async unsubscribe(token: string) {
    const [userId, category] = this.tokens.verify("unsubscribe", token) ?? [];
    if (!userId || !category || !(category in notificationCategories))
      throw new AppError("UNSUBSCRIBE_LINK_INVALID");
    const name = category as NotificationCategory;
    if (!notificationCategories[name].mutable) throw new AppError("UNSUBSCRIBE_LINK_INVALID");
    await this.updatePreferences(userId, {
      channels: [{ category: name, channel: "email", enabled: false }],
    });
    return { category: name };
  }
}
