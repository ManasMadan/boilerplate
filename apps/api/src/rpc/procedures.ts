/**
 * The procedure builders every feature router uses. They implement the contract in
 * packages/contracts and add, in order:
 *
 *   base    error mapping (AppError → typed contract error) + client version gate
 *   authed  + a valid session (UNAUTHENTICATED otherwise); `context.user`, `context.session`
 *   inOrg   + an active organization; `context.orgId` (tenant for row-level security)
 *
 *   export const todoRouter = ({ inOrg }: Procedures, todos: TodoService) => ({
 *     list: inOrg.todo.list.handler(({ context, input }) => todos.list(context.orgId, input)),
 *   });
 *
 * This is the only request pipeline for the API: Nest provides modules and dependency
 * injection, while auth, tenancy, rate limits and errors live here, where they are typed
 * and apply identically to RPC and REST.
 */

import { implement, ORPCError, ValidationError } from "@orpc/server";
import { contract, type ErrorData } from "@repo/contracts/api";
import { type ErrorCode, isErrorCode } from "@repo/contracts/errors";
import { AppError, currentContext, updateContext } from "@repo/nest-common";
import type { Auth } from "../auth/auth";
import { env } from "../env";

export interface RpcContext {
  headers: Headers;
}

type ErrorParams = ErrorData["params"];

/** Maps anything thrown inside a procedure to the contract's error shape. */
export function toContractError(
  error: unknown,
  log: (error: unknown) => void,
): ORPCError<ErrorCode, unknown> {
  const requestId = currentContext()?.requestId;
  if (error instanceof AppError) {
    return new ORPCError(error.code, {
      status: error.status,
      data: { params: error.params, requestId },
    });
  }
  if (error instanceof ORPCError) {
    // Input validation failures carry the zod issues; send codes and paths, not English messages.
    if (error.code === "BAD_REQUEST" && error.cause instanceof ValidationError) {
      const issues = error.cause.issues.map((issue) => ({
        path: (issue.path ?? []).map((segment) =>
          typeof segment === "object" ? String(segment.key) : segment,
        ) as (string | number)[],
        code: "code" in issue && typeof issue.code === "string" ? issue.code : "invalid",
      }));
      return new ORPCError("VALIDATION_FAILED", {
        status: 422,
        data: { params: {} as ErrorParams, requestId, issues },
      });
    }
    if (isErrorCode(error.code)) {
      const data = (error.data ?? {}) as { params?: ErrorParams };
      return new ORPCError(error.code, {
        status: error.status,
        data: { params: data.params ?? {}, requestId },
      });
    }
  }
  log(error);
  return new ORPCError("INTERNAL", { status: 500, data: { params: {} as ErrorParams, requestId } });
}

/** Compares dotted versions ("1.12.0" < "1.2.0" is false). Missing parts count as 0. */
export function isOlderVersion(version: string, minimum: string) {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}

export function createProcedures(auth: Auth) {
  const os = implement(contract).$context<RpcContext>();

  const base = os.use(async ({ next }) => {
    const version = currentContext()?.clientVersion;
    if (version && isOlderVersion(version, env.MINIMUM_CLIENT_VERSION)) {
      throw new AppError("CLIENT_OUTDATED", {
        params: { minimumVersion: env.MINIMUM_CLIENT_VERSION },
      });
    }
    return next();
  });

  const authed = base.use(async ({ context, next }) => {
    const result = await auth.api.getSession({ headers: context.headers });
    if (!result) throw new AppError("UNAUTHENTICATED");
    updateContext({ userId: result.user.id, locale: result.user.locale ?? undefined });
    return next({ context: { user: result.user, session: result.session } });
  });

  const inOrg = authed.use(async ({ context, next }) => {
    const orgId = context.session.activeOrganizationId;
    if (!orgId) throw new AppError("NO_ACTIVE_ORGANIZATION");
    updateContext({ orgId });
    return next({ context: { orgId } });
  });

  return { os, base, authed, inOrg };
}

export type Procedures = ReturnType<typeof createProcedures>;
