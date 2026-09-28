/** Pure cache transforms for optimistic todo updates (unit-tested, no React). */
import type { Todo } from "@repo/contracts/api";
import type { TodoListData } from "./list";

const mapItems = (
  data: TodoListData | undefined,
  fn: (items: Todo[]) => Todo[],
): TodoListData | undefined =>
  data && { ...data, pages: data.pages.map((page) => ({ ...page, items: fn(page.items) })) };

export const applySetCompleted = (data: TodoListData | undefined, id: string, completed: boolean) =>
  mapItems(data, (items) =>
    items.map((todo) =>
      todo.id === id ? { ...todo, completed, version: todo.version + 1 } : todo,
    ),
  );

export const applyDelete = (data: TodoListData | undefined, id: string) =>
  mapItems(data, (items) => items.filter((todo) => todo.id !== id));

export const applyCreate = (data: TodoListData | undefined, todo: Todo): TodoListData | undefined =>
  data && {
    ...data,
    pages: data.pages.map((page, index) =>
      index === 0 ? { ...page, items: [todo, ...page.items] } : page,
    ),
  };
