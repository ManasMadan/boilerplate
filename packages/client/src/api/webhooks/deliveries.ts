/**
 * An endpoint's delivery log, newest first, page by page, and replaying one delivery.
 * Delivery happens in the background, so the log is polled while anything is pending.
 */
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useWebhookDeliveriesInfiniteQuery(endpointId: string, limit = 20) {
  const { api } = useApi();
  return useInfiniteQuery(
    api.webhooks.listDeliveries.infiniteOptions({
      input: (cursor: string | undefined) => ({ id: endpointId, limit, ...(cursor && { cursor }) }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      refetchInterval: (query) =>
        query.state.data?.pages.some((page) => page.items.some((item) => item.status === "pending"))
          ? 2_000
          : false,
    }),
  );
}

export function useRedeliverWebhookMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.webhooks.redeliver.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: api.webhooks.listDeliveries.key() }),
    }),
  );
}
