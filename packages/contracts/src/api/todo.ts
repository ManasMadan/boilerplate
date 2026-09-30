/** The example feature. Copy this file's shape for new features. */
import * as z from "zod";
import { page, pageInput } from "../pagination";
import { base, errorsOf, WORKSPACE_ERRORS } from "./base";

/** The codes this module's procedures throw, on top of the common ones. */
const errors = errorsOf(
  ...WORKSPACE_ERRORS,
  "API_KEY_SCOPE_MISSING",
  "TODO_NOT_FOUND",
  "TODO_VERSION_CONFLICT",
);

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

const todoPageSchema = page(todoSchema);
export type TodoPage = z.infer<typeof todoPageSchema>;

export const todoTitle = z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH);

export const createTodoInput = z.object({ title: todoTitle });
export const setTodoCompletedInput = z.object({
  id: z.uuid(),
  completed: z.boolean(),
  version: z.number().int(),
});
export const deleteTodoInput = z.object({ id: z.uuid() });

/**
 * Todo changes are limited in TodoService, not here: the MCP server's tools change todos
 * through it too, and every way in spends the workspace's one allowance.
 */
const todoWrites = {
  exempt: "TodoService limits a workspace's changes itself, so MCP's share the same allowance.",
} as const;

export const todoContract = {
  list: base
    .errors(errors)
    .meta({ apiKeyScope: "todos:read" })
    .route({
      method: "GET",
      path: "/todos",
      tags: ["Todos"],
      summary: "List the organization's todos, newest first",
    })
    .input(pageInput)
    .output(todoPageSchema),
  create: base
    .errors(errors)
    .meta({ apiKeyScope: "todos:write", rateLimit: todoWrites })
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
    .errors(errors)
    .meta({ apiKeyScope: "todos:write", rateLimit: todoWrites })
    .route({
      method: "PATCH",
      path: "/todos/{id}",
      tags: ["Todos"],
      summary: "Mark a todo done or not done",
    })
    .input(setTodoCompletedInput)
    .output(todoSchema),
  delete: base
    .errors(errors)
    .meta({ apiKeyScope: "todos:write", rateLimit: todoWrites })
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
