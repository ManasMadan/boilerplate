/** Enabled features and the running release. Changes only on deploy, so cached long. */
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useSystemInfoQuery() {
  const { api } = useApi();
  return useQuery(api.system.info.queryOptions({ staleTime: 10 * 60_000 }));
}
