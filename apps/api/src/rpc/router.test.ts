/**
 * Rules every procedure of the router follows, checked over all of them: it checks who's
 * calling (a session, or an API key where the contract allows one), unless it's one of
 * the public endpoints listed here, each with its reason.
 */
import type { INestApplication } from "@nestjs/common";
import { call, isProcedure } from "@orpc/server";
import type { ProcedureMeta } from "@repo/contracts/api";
import { isAppError, type Redis } from "@repo/nest-common";
import { describe, expect, it } from "vitest";
import type { Auth } from "../auth/auth";
import type { Memberships } from "../auth/memberships";
import { createProcedures } from "./procedures";
import { createRouter } from "./router";

/** Anyone may call these, signed in or not. */
const PUBLIC: Record<string, string> = {
  "system.info":
    "Clients read it before anyone signs in: the enabled features, the oldest supported app version, and the captcha and push keys.",
  "notifications.unsubscribe":
    "Opened from an email's unsubscribe link, often signed out: the signed token in the link is what authorizes it.",
};

type Procedure = Parameters<typeof call>[0] & { "~orpc": { meta: unknown } };

/** Every procedure of a router, by its dotted path. */
function proceduresOf(router: object, prefix = ""): [string, Procedure][] {
  return Object.entries(router).flatMap(([key, child]: [string, object]) =>
    isProcedure(child) ? [[`${prefix}${key}`, child]] : proceduresOf(child, `${prefix}${key}.`),
  );
}

// No session behind any call, and nothing past the checks is reached: no services, and
// Redis only once a caller is known (their rate limit).
const auth = { api: { getSession: async () => null } } as unknown as Auth;
const router = createRouter(
  createProcedures(
    auth,
    {} as Memberships,
    () => Promise.reject(new Error("no API key is sent")),
    {} as Redis,
  ),
  { get: () => ({}) } as unknown as INestApplication,
);
const procedures = proceduresOf(router);

/** What a call without a session or key ends in: an error code, or "answered". */
async function anonymousCall(procedure: Procedure) {
  try {
    await call(procedure, undefined, { context: { headers: new Headers() } });
    return "answered";
  } catch (error) {
    return isAppError(error) ? error.code : "failed";
  }
}

describe("authorization", () => {
  it("refuses every call without a session, except the public endpoints", async () => {
    const open: string[] = [];
    for (const [path, procedure] of procedures) {
      if (!(path in PUBLIC) && (await anonymousCall(procedure)) !== "UNAUTHENTICATED")
        open.push(path);
    }
    expect(open).toEqual([]);
  });

  it("lists only public endpoints that exist and are open, and says why", async () => {
    const paths = new Map(procedures);
    for (const [path, reason] of Object.entries(PUBLIC)) {
      const procedure = paths.get(path);
      expect(procedure, path).toBeDefined();
      expect(await anonymousCall(procedure as Procedure), path).not.toBe("UNAUTHENTICATED");
      expect(reason.length, path).toBeGreaterThan(20);
      // Their builder doesn't know who's calling, so it can't apply a limit.
      const { rateLimit } = (procedure as Procedure)["~orpc"].meta as ProcedureMeta;
      expect(rateLimit === undefined || "exempt" in rateLimit, path).toBe(true);
    }
  });
});
