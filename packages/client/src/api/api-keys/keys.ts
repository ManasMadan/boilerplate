/**
 * The active workspace's API keys (owners and admins).
 *
 *   const keys = useApiKeysQuery();
 *   const create = useCreateApiKeyMutation();
 *   const { key } = await create.mutateAsync({ name, scopes, expiresInDays });   // show it once
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useApiKeysQuery() {
  const { api } = useApi();
  return useQuery(api.apiKeys.list.queryOptions());
}

function useInvalidateApiKeys() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: api.apiKeys.list.key() });
}

export function useCreateApiKeyMutation() {
  const { api } = useApi();
  const invalidate = useInvalidateApiKeys();
  return useMutation(api.apiKeys.create.mutationOptions({ onSuccess: invalidate }));
}

/** The key stops working immediately. */
export function useRevokeApiKeyMutation() {
  const { api } = useApi();
  const invalidate = useInvalidateApiKeys();
  return useMutation(api.apiKeys.revoke.mutationOptions({ onSettled: invalidate }));
}
