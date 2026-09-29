/**
 * Messages pushed to signed-in clients over the realtime stream (oRPC event iterator,
 * served as Server-Sent Events). They are nudges, not data: "something you're looking at
 * changed", so the client refetches through the normal API with its normal checks.
 * Keeping them tiny means a message can never leak data the reader couldn't fetch.
 *
 * Channels: every user has one, every organization has one. A stream carries the user's
 * channel and their active organization's.
 */
import * as z from "zod";

export const realtimeMessage = z.discriminatedUnion("type", [
  /** Todos in the organization changed (created, completed, deleted). */
  z.object({ type: z.literal("todos.changed") }),
  /** The user's in-app notifications changed (a new one, or read elsewhere). */
  z.object({ type: z.literal("notifications.changed") }),
  /** The organization's assistant documents changed (added, indexed, removed). */
  z.object({ type: z.literal("documents.changed") }),
  /** One of the user's uploads was checked (ready or rejected). */
  z.object({ type: z.literal("files.changed") }),
]);
export type RealtimeMessage = z.infer<typeof realtimeMessage>;

export const realtimeChannel = {
  user: (userId: string) => `user:${userId}`,
  org: (orgId: string) => `org:${orgId}`,
};
