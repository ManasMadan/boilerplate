/** What the user receives: per category and channel, the daily digest, quiet hours. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useNotificationPreferencesQuery() {
  const { api } = useApi();
  return useQuery(api.notifications.preferences.queryOptions());
}

export function useUpdateNotificationPreferencesMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.notifications.updatePreferences.mutationOptions({
      onSuccess: (preferences) =>
        queryClient.setQueryData(api.notifications.preferences.queryKey(), preferences),
    }),
  );
}

/** From an email's unsubscribe link (works signed out). */
export function useUnsubscribeMutation() {
  const { api } = useApi();
  return useMutation(api.notifications.unsubscribe.mutationOptions());
}
