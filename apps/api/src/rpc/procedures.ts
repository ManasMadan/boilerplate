/**
 * The procedure builders every feature router uses. They implement the contract in
 * packages/contracts and add, in order:
 *
 *   base    error mapping (AppError → typed contract error) + client version gate
 *   authed  + a valid session (UNAUTHENTICATED otherwise); `context.user`, `context.session`
 *   fresh   + signed in within FRESH_SESSION_AGE ("sudo mode"; FRESH_SESSION_REQUIRED)
 *   inOrg   a signed-in member of the active organization, or an API key with the
 *           procedure's scope; `context.orgId` (tenant for row-level security),
 *           `context.userId`, `context.role`, `context.apiKeyId`
 *
 *   export const todoRouter = ({ inOrg }: Procedures, todos: TodoService) => ({
 *     list: inOrg.todo.list.handler(({ context, input }) => todos.list(context.orgId, input)),
 *   });
 *
 * This is the only request pipeline for the API: Nest provides modules and dependency
 * injection, while auth, tenancy and error mapping live here, where they are typed and
 * apply identically to RPC and REST. Rate limits sit with what they protect: better-auth's
 * for sign-in, and the services' own limiters (AI, MCP).
 */

import { implement, ORPCError, ValidationError } from "@orpc/server";
import { API_KEY_HEADER, type ApiKeyScope, contract, type ErrorData } from "@repo/contracts/api";
import { FRESH_SESSION_AGE } from "@repo/contracts/auth";
import { type ErrorCode, isErrorCode } from "@repo/contracts/errors";
import { AppError, currentContext, updateContext } from "@repo/nest-common";
import type { Auth } from "../auth/auth";
import type { Memberships, OrgRole } from "../auth/memberships";
import { env } from "../env";

export interface RpcContext {
  headers: Headers;
}

/** Who an organization-scoped call acts as. `apiKeyId` is set when an API key made it. */
export interface OrgCaller {
  orgId: string;
  userId: string;
  role: OrgRole;
  apiKeyId: string | null;
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
function isOlderVersion(version: string, minimum: string) {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}

/** Checks an API key for a procedure that needs `scope` (modules/api-keys). */
export type AuthenticateApiKey = (key: string, scope: ApiKeyScope) => Promise<OrgCaller>;

export function createProcedures(
  auth: Auth,
  memberships: Memberships,
  authenticateApiKey: AuthenticateApiKey,
) {
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

  // Sensitive account changes, like better-auth's own fresh-session rule.
  const fresh = authed.use(async ({ context, next }) => {
    if (Date.now() - new Date(context.session.createdAt).getTime() >= FRESH_SESSION_AGE * 1000)
      throw new AppError("FRESH_SESSION_REQUIRED");
    return next();
  });

  // Organization-scoped calls act in one organization, as one user, with their role there:
  //   - a signed-in person: the session's active organization. Membership is re-checked
  //     every time, so someone removed from it loses access immediately (see
  //     auth/memberships.ts).
  //   - an API key (`x-api-key`): its workspace, as its creator, and only for procedures
  //     whose contract names a scope the key has (see modules/api-keys).
  async function orgCaller(headers: Headers, scope: ApiKeyScope | undefined): Promise<OrgCaller> {
    const apiKey = headers.get(API_KEY_HEADER);
    if (apiKey !== null) {
      // Everything without a scope is for signed-in people only.
      if (!scope) throw new AppError("FORBIDDEN");
      return authenticateApiKey(apiKey, scope);
    }
    const result = await auth.api.getSession({ headers });
    if (!result) throw new AppError("UNAUTHENTICATED");
    updateContext({ userId: result.user.id, locale: result.user.locale ?? undefined });
    const orgId = result.session.activeOrganizationId;
    if (!orgId) throw new AppError("NO_ACTIVE_ORGANIZATION");
    const role = await memberships.role(orgId, result.user.id);
    if (!role) throw new AppError("NO_ACTIVE_ORGANIZATION");
    return { orgId, role, userId: result.user.id, apiKeyId: null };
  }

  const inOrg = base.use(async ({ context, next, procedure }) => {
    const caller = await orgCaller(context.headers, procedure["~orpc"].meta.apiKeyScope);
    updateContext({ userId: caller.userId, orgId: caller.orgId });
    return next({ context: caller });
  });

  /** Organization owners and admins only (settings, members, audit log). */
  const orgAdmin = inOrg.use(async ({ context, next }) => {
    if (context.role === "member") throw new AppError("FORBIDDEN");
    return next();
  });

  return { os, base, authed, fresh, inOrg, orgAdmin };
}

export type Procedures = ReturnType<typeof createProcedures>;
