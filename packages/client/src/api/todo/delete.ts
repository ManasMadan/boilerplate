/** Deletes a todo, removing it from the list immediately and restoring it on failure. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";
import { type TodoListData, useTodoListQueryKey } from "./list";
import { applyDelete } from "./optimistic";

export function useTodoDeleteMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const listKey = useTodoListQueryKey();
  return useMutation(
    api.todo.delete.mutationOptions({
      onMutate: async ({ id }) => {
        await queryClient.cancelQueries({ queryKey: listKey });
        const previous = queryClient.getQueriesData<TodoListData>({ queryKey: listKey });
        queryClient.setQueriesData<TodoListData>({ queryKey: listKey }, (data) =>
          applyDelete(data, id),
        );
        return { previous };
      },
      onError: (_error, _input, context) => {
        for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
    }),
  );
}
