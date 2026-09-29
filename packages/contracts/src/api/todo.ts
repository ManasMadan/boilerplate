/** The example feature. Copy this file's shape for new features. */
import * as z from "zod";
import { page, pageInput } from "../pagination";
import { base } from "./base";

export const TODO_TITLE_MAX_LENGTH = 200;

export const todoSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  completed: z.boolean(),
  /** Send back on updates; a stale version is rejected with TODO_VERSION_CONFLICT. */
  version: z.number().int(),
  createdAt: z.date(),
});
export type Todo = z.infer<typeof todoSchema>;

export const todoTitle = z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH);

export const createTodoInput = z.object({ title: todoTitle });
export const setTodoCompletedInput = z.object({
  id: z.uuid(),
  completed: z.boolean(),
  version: z.number().int(),
});
export const deleteTodoInput = z.object({ id: z.uuid() });

export const todoContract = {
  list: base
    .meta({ apiKeyScope: "todos:read" })
    .route({
      method: "GET",
      path: "/todos",
      tags: ["Todos"],
      summary: "List the organization's todos, newest first",
    })
    .input(pageInput)
    .output(page(todoSchema)),
  create: base
    .meta({ apiKeyScope: "todos:write" })
    .route({
      method: "POST",
      path: "/todos",
      tags: ["Todos"],
      summary: "Create a todo",
      successStatus: 201,
    })
    .input(createTodoInput)
    .output(todoSchema),
  setCompleted: base
    .meta({ apiKeyScope: "todos:write" })
    .route({
      method: "PATCH",
      path: "/todos/{id}",
      tags: ["Todos"],
      summary: "Mark a todo done or not done",
    })
    .input(setTodoCompletedInput)
    .output(todoSchema),
  delete: base
    .meta({ apiKeyScope: "todos:write" })
    .route({
      method: "DELETE",
      path: "/todos/{id}",
      tags: ["Todos"],
      summary: "Delete a todo",
      successStatus: 204,
    })
    .input(deleteTodoInput)
    .output(z.void()),
};
