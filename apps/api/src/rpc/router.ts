/**
 * The full API router. `os.router` checks it against the contract: a procedure that is
 * in packages/contracts but not implemented here (or vice versa) is a compile error.
 *
 * To add a feature: define its procedures in packages/contracts/src/api, write a module
 * under src/modules/<feature> (module, service, repository, router), register the module
 * in app.module.ts and its router below.
 */
import type { INestApplication } from "@nestjs/common";
import { AiService, aiRouter } from "../modules/ai";
import { systemRouter } from "../modules/system";
import { TodoService, todoRouter } from "../modules/todo";
import { userRouter } from "../modules/user";
import type { Procedures } from "./procedures";

export function createRouter(procedures: Procedures, app: INestApplication) {
  return procedures.os.router({
    system: systemRouter(procedures),
    user: userRouter(procedures),
    todo: todoRouter(procedures, app.get(TodoService)),
    ai: aiRouter(procedures, app.get(AiService)),
  });
}

export type AppRouter = ReturnType<typeof createRouter>;
