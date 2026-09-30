/**
 * Verifies MCP access tokens: JWTs this service's authorization server signed, for this
 * MCP server, naming a workspace, whose grant still stands. Keys come straight from
 * better-auth (no network hop); a token signed with a key this process hasn't loaded
 * (after a rotation) reloads them, at most every KEY_RELOAD_MS: otherwise any made-up key
 * id would cost a database query (the Python side waits the same).
 */
import { ORG_CLAIM } from "@repo/contracts/mcp";
import {
  createLocalJWKSet,
  errors,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";

export interface McpCaller {
  userId: string;
  orgId: string;
  clientId: string;
  scopes: ReadonlySet<string>;
  token: string;
}

export type Verified = { ok: true; caller: McpCaller } | { ok: false; description: string };

/** The least time between two key reloads. */
export const KEY_RELOAD_MS = 30_000;

export interface TokenVerifierOptions {
  keys: () => Promise<JSONWebKeySet>;
  issuer: string;
  audience: string;
  /** auth.mcp_grant_active: the approval exists and the user is still a member. */
  grantActive: (clientId: string, userId: string, orgId: string) => Promise<boolean>;
  /** The clock, for tests. */
  now?: () => number;
}

export function createTokenVerifier(options: TokenVerifierOptions) {
  const now = options.now ?? Date.now;
  let keys: JWTVerifyGetKey | undefined;
  let loadedAt = Number.NEGATIVE_INFINITY;
  const load = async () => {
    loadedAt = now();
    keys = createLocalJWKSet(await options.keys());
    return keys;
  };
  const verifyWith = (token: string, getKey: JWTVerifyGetKey) =>
    jwtVerify(token, getKey, { issuer: options.issuer, audience: options.audience });

  async function claims(token: string): Promise<JWTPayload> {
    try {
      return (await verifyWith(token, keys ?? (await load()))).payload;
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey) || now() - loadedAt < KEY_RELOAD_MS)
        throw error;
      return (await verifyWith(token, await load())).payload;
    }
  }

  return async function verify(token: string): Promise<Verified> {
    let payload: JWTPayload;
    try {
      payload = await claims(token);
    } catch (error) {
      return {
        ok: false,
        description:
          error instanceof errors.JWTExpired ? "The access token expired" : "Invalid access token",
      };
    }
    const orgId = payload[ORG_CLAIM];
    const clientId = payload.azp;
    if (
      typeof payload.sub !== "string" ||
      typeof orgId !== "string" ||
      typeof clientId !== "string"
    ) {
      return { ok: false, description: "The access token names no workspace" };
    }
    if (!(await options.grantActive(clientId, payload.sub, orgId))) {
      return { ok: false, description: "The app was disconnected or left the workspace" };
    }
    const scope = typeof payload.scope === "string" ? payload.scope : "";
    return {
      ok: true,
      caller: {
        userId: payload.sub,
        orgId,
        clientId,
        scopes: new Set(scope.split(" ").filter(Boolean)),
        token,
      },
    };
  };
}
