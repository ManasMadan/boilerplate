/**
 * onSettled for todo mutations: refetch the list, but only when the last overlapping
 * todo mutation settles. Otherwise an earlier mutation's refetch can land after a later
 * optimistic change and bring back, say, a todo that was just deleted.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useSettleTodoMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const listKey = api.todo.list.key();
  const mutationKey = api.todo.key({ type: "mutation" });
  // The settling mutation still counts itself, hence 1.
  return () =>
    queryClient.isMutating({ mutationKey }) === 1
      ? queryClient.invalidateQueries({ queryKey: listKey })
      : undefined;
}
