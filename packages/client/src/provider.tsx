/**
 * Provides the API client and TanStack Query to a React tree (web and mobile).
 *
 *   <ApiProvider options={{ appVersion }} onUnauthenticated={() => router.replace("/sign-in")}>
 *
 * Global behaviour lives here, once:
 * - any UNAUTHENTICATED error (session expired, signed out elsewhere, revoked) clears
 *   every cached query, so no previous user's data stays on screen, and calls
 *   `onUnauthenticated`;
 * - CLIENT_OUTDATED calls `onOutdated` (show "please update");
 * - retries only errors that can succeed on retry (network, 5xx), never 4xx.
 */
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, type ReactNode, use, useState } from "react";
import { type ApiClient, type ApiClientOptions, type ApiUtils, createApiClient } from "./client";
import { errorCode } from "./errors";

interface ApiContextValue {
  client: ApiClient;
  api: ApiUtils;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export interface ApiProviderProps {
  options?: ApiClientOptions;
  onUnauthenticated?: () => void | Promise<void>;
  onOutdated?: () => void;
  children: ReactNode;
}

const RETRYABLE = new Set(["SERVICE_UNAVAILABLE", "INTERNAL", "UPSTREAM_UNAVAILABLE"]);

export function ApiProvider({
  options,
  onUnauthenticated,
  onOutdated,
  children,
}: ApiProviderProps) {
  const [value] = useState<ApiContextValue & { queryClient: QueryClient }>(() => {
    const handle = (error: unknown) => {
      const code = errorCode(error);
      if (code === "UNAUTHENTICATED") {
        queryClient.clear();
        void onUnauthenticated?.();
      } else if (code === "CLIENT_OUTDATED") {
        onOutdated?.();
      }
    };
    const queryClient: QueryClient = new QueryClient({
      queryCache: new QueryCache({ onError: handle }),
      mutationCache: new MutationCache({ onError: handle }),
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          retry: (count, error) => RETRYABLE.has(errorCode(error)) && count < 2,
        },
        mutations: { retry: false },
      },
    });
    return { ...createApiClient(options), queryClient };
  });

  return (
    <QueryClientProvider client={value.queryClient}>
      <ApiContext value={value}>{children}</ApiContext>
    </QueryClientProvider>
  );
}

/** The typed client and query utilities. Hooks in `api/*` use this; apps rarely need it. */
export function useApi(): ApiContextValue {
  const value = use(ApiContext);
  if (!value) throw new Error("useApi must be used inside <ApiProvider>");
  return value;
}
