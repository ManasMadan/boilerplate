/**
 * Todo business rules. Each change and its domain event are written in one tenant
 * transaction, so the audit log, webhooks and notifications never miss or invent one.
 */
import { Injectable } from "@nestjs/common";
import { type PageInput, toPage } from "@repo/contracts/pagination";
import { tenantTx } from "@repo/db";
import { AppError, type Database, InjectDatabase } from "@repo/nest-common";
import { emitEvent } from "../../outbox";
import { TodoRepository } from "./todo.repository";

@Injectable()
export class TodoService {
  constructor(
    @InjectDatabase() private readonly database: Database,
    private readonly todos: TodoRepository,
  ) {}

  async list(orgId: string, page: PageInput) {
    return toPage(await this.todos.list(orgId, page), page.limit);
  }

  create(orgId: string, userId: string, title: string) {
    return tenantTx(this.database.write, orgId, async (tx) => {
      const todo = await this.todos.create(tx, { orgId, createdById: userId, title });
      await emitEvent(tx, "todo.created.v1", todo.id, { todoId: todo.id, title: todo.title });
      return todo;
    });
  }

  setCompleted(orgId: string, input: { id: string; completed: boolean; version: number }) {
    return tenantTx(this.database.write, orgId, async (tx) => {
      const todo = await this.todos.setCompleted(tx, input);
      if (!todo) {
        // Distinguish "someone else changed it first" from "it doesn't exist (for you)".
        const exists = await this.todos.exists(tx, input.id);
        throw new AppError(exists ? "TODO_VERSION_CONFLICT" : "TODO_NOT_FOUND", {
          params: { id: input.id },
        });
      }
      if (todo.completed) {
        await emitEvent(tx, "todo.completed.v1", todo.id, { todoId: todo.id, title: todo.title });
      }
      return todo;
    });
  }

  delete(orgId: string, id: string) {
    return tenantTx(this.database.write, orgId, async (tx) => {
      if (!(await this.todos.delete(tx, id)))
        throw new AppError("TODO_NOT_FOUND", { params: { id } });
      await emitEvent(tx, "todo.deleted.v1", id, { todoId: id });
    });
  }
}
