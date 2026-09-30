/** The public details of an app asking, over OAuth, to act for the user (its name). */
import { useQuery } from "@tanstack/react-query";
import type { AuthQueryClient } from "./client";
import { authData, authKeys } from "./query";

export function useOAuthClientQuery(auth: AuthQueryClient, clientId: string | null) {
  return useQuery({
    queryKey: authKeys.oauthClient(clientId),
    enabled: Boolean(clientId),
    retry: false,
    queryFn: () => authData(auth.oauth2.publicClient({ query: { client_id: clientId as string } })),
  });
}
