/**
 * Apps (MCP clients) connected to the user's workspaces over OAuth.
 *
 *   const apps = useConnectedAppsQuery();
 *   const disconnect = useDisconnectAppMutation();
 *   await disconnect.mutateAsync({ id });   // the app loses access at once
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useConnectedAppsQuery() {
  const { api } = useApi();
  return useQuery(api.apps.list.queryOptions());
}

export function useInvalidateConnectedAppsQuery() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: api.apps.list.key() });
}

export function useDisconnectAppMutation() {
  const { api } = useApi();
  const invalidate = useInvalidateConnectedAppsQuery();
  return useMutation(api.apps.disconnect.mutationOptions({ onSettled: invalidate }));
}
