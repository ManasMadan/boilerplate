/**
 * The active organization's plan (owners and admins).
 *
 *   const { data } = useBillingOverviewQuery();
 *   const checkout = useCheckoutMutation();
 *   window.location.assign((await checkout.mutateAsync({ interval: "month" })).url);
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useApi } from "../provider";

/**
 * `untilPaid`: after returning from checkout, Stripe's webhook takes a moment to arrive,
 * so look again every couple of seconds (for up to a minute) until the plan is paid.
 */
export function useBillingOverviewQuery({ untilPaid = false }: { untilPaid?: boolean } = {}) {
  const { api } = useApi();
  return useQuery(
    api.billing.overview.queryOptions({
      refetchInterval: (query) =>
        untilPaid && query.state.data?.plan === "free" && query.state.dataUpdateCount < 30
          ? 2_000
          : false,
    }),
  );
}

export function useInvoicesQuery(enabled: boolean) {
  const { api } = useApi();
  return useQuery(api.billing.invoices.queryOptions({ enabled }));
}

export function useCheckoutMutation() {
  const { api } = useApi();
  return useMutation(api.billing.checkout.mutationOptions());
}

export function usePortalMutation() {
  const { api } = useApi();
  return useMutation(api.billing.portal.mutationOptions());
}
