/**
 * The organization's todos, newest first, loaded page by page.
 *
 *   const todos = useTodoListInfiniteQuery();
 *   todos.data?.pages.flatMap((page) => page.items)
 *   todos.fetchNextPage()   // when todos.hasNextPage
 */

import type { Todo } from "@repo/contracts/api";
import { type InfiniteData, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export const TODO_PAGE_SIZE = 20;

export type TodoPage = { items: Todo[]; nextCursor: string | null };
export type TodoListData = InfiniteData<TodoPage, string | undefined>;

export function useTodoListInfiniteQuery(limit = TODO_PAGE_SIZE) {
  const { api } = useApi();
  return useInfiniteQuery(
    api.todo.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit, ...(cursor && { cursor }) }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
  );
}

/** Matches every page size and cursor of the todo list. */
export function useTodoListQueryKey() {
  const { api } = useApi();
  return api.todo.list.key();
}

/** Refetch the todo list (e.g. after a change made elsewhere). */
export function useInvalidateTodoListQuery() {
  const queryClient = useQueryClient();
  const key = useTodoListQueryKey();
  return () => queryClient.invalidateQueries({ queryKey: key });
}
