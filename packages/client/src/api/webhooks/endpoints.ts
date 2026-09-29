/**
 * Webhook endpoints of the active organization (owners and admins).
 *
 *   const endpoints = useWebhookEndpointsQuery();
 *   const create = useCreateWebhookEndpointMutation();
 *   const { secret } = await create.mutateAsync({ url, events });   // show it once
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useWebhookEndpointsQuery() {
  const { api } = useApi();
  return useQuery(api.webhooks.listEndpoints.queryOptions());
}

/** Refetches the endpoint list after any change. */
function useInvalidateEndpoints() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: api.webhooks.listEndpoints.key() });
}

export function useCreateWebhookEndpointMutation() {
  const { api } = useApi();
  const invalidate = useInvalidateEndpoints();
  return useMutation(api.webhooks.createEndpoint.mutationOptions({ onSuccess: invalidate }));
}

export function useUpdateWebhookEndpointMutation() {
  const { api } = useApi();
  const invalidate = useInvalidateEndpoints();
  return useMutation(api.webhooks.updateEndpoint.mutationOptions({ onSuccess: invalidate }));
}

export function useDeleteWebhookEndpointMutation() {
  const { api } = useApi();
  const invalidate = useInvalidateEndpoints();
  return useMutation(api.webhooks.deleteEndpoint.mutationOptions({ onSuccess: invalidate }));
}

/** Returns the new secret; the old one stops working immediately. */
export function useRotateWebhookSecretMutation() {
  const { api } = useApi();
  return useMutation(api.webhooks.rotateSecret.mutationOptions());
}

export function useSendWebhookTestMutation() {
  const { api } = useApi();
  return useMutation(api.webhooks.sendTest.mutationOptions());
}
