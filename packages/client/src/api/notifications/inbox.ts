/**
 * The signed-in user's in-app notifications. Kept fresh by the realtime stream
 * (useLiveUpdates refetches on "notifications.changed").
 *
 *   const inbox = useNotificationsInfiniteQuery();
 *   const { data } = useUnreadNotificationsCountQuery();   // { count }
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useNotificationsInfiniteQuery(limit = 20) {
  const { api } = useApi();
  return useInfiniteQuery(
    api.notifications.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit, ...(cursor && { cursor }) }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
  );
}

export function useUnreadNotificationsCountQuery() {
  const { api } = useApi();
  return useQuery(api.notifications.unreadCount.queryOptions());
}

function useInvalidateInbox() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: api.notifications.key() });
}

export function useMarkNotificationsReadMutation() {
  const { api } = useApi();
  return useMutation(
    api.notifications.markRead.mutationOptions({ onSuccess: useInvalidateInbox() }),
  );
}

export function useMarkAllNotificationsReadMutation() {
  const { api } = useApi();
  return useMutation(
    api.notifications.markAllRead.mutationOptions({ onSuccess: useInvalidateInbox() }),
  );
}
