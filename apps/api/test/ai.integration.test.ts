/**
 * The API's side of the AI features against a strict stand-in for the Python service:
 * it checks the per-call token the API signs, and answers the way the real service does
 * (including its error codes and its event stream). The real service is covered by its
 * own tests (apps/ai) and end to end by the web suite.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ORPCError } from "@orpc/client";
import { jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSession,
  type Harness,
  newEmail,
  newPassword,
  startApi,
  takeNotification,
  takeOtp,
} from "./harness";

const SECRET = `test-ai-secret-${randomUUID()}`;

interface Doc {
  id: string;
  org: string;
  title: string;
  status: string;
  error: null;
  chunkCount: number;
  summary: string | null;
  createdBy: string;
  createdAt: string;
}

let harness: Harness;
let ai: Server;
const documents: Doc[] = [];
const calls: { path: string; org: string; user: string; requestId: string | undefined }[] = [];
/** Per organization: what the next answer does. */
const behaviour = new Map<string, "answer" | "budget" | "stream-error" | "down">();

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
}

beforeAll(async () => {
  ai = createServer(async (request, response) => {
    const reply = (status: number, payload?: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(payload === undefined ? undefined : JSON.stringify(payload));
    };
    let claims: { sub?: string; org?: unknown };
    try {
      const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
      ({ payload: claims } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
        issuer: "api",
        audience: "ai",
        maxTokenAge: 120,
      }));
    } catch {
      return reply(401, { code: "UNAUTHENTICATED", status: 401, params: {} });
    }
    const org = String(claims.org);
    const user = String(claims.sub);
    const path = new URL(request.url ?? "/", "http://ai").pathname;
    calls.push({
      path,
      org,
      user,
      requestId: request.headers["x-request-id"] as string | undefined,
    });
    const input = await body(request);

    if (request.method === "POST" && path === "/v1/sentiment") {
      return reply(200, { label: "positive", score: 0.9, model: "fake" });
    }
    if (request.method === "GET" && path === "/v1/documents") {
      return reply(
        200,
        documents.filter((d) => d.org === org),
      );
    }
    if (request.method === "POST" && path === "/v1/documents") {
      const doc: Doc = {
        id: randomUUID(),
        org,
        title: input.title,
        status: "pending",
        error: null,
        chunkCount: 0,
        summary: null,
        createdBy: user,
        createdAt: new Date().toISOString(),
      };
      documents.push(doc);
      return reply(201, doc);
    }
    const remove = /^\/v1\/documents\/([0-9a-f-]{36})$/.exec(path);
    if (request.method === "DELETE" && remove) {
      const index = documents.findIndex((d) => d.id === remove[1] && d.org === org);
      if (index === -1) return reply(404, { code: "DOCUMENT_NOT_FOUND", status: 404, params: {} });
      documents.splice(index, 1);
      return reply(204);
    }
    if (request.method === "POST" && path === "/v1/assistant/answers") {
      const mode = behaviour.get(org) ?? "answer";
      if (mode === "budget")
        return reply(429, { code: "AI_BUDGET_EXCEEDED", status: 429, params: {} });
      if (mode === "down") return reply(500, { code: "INTERNAL", status: 500, params: {} });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: unknown) => response.write(`data: ${JSON.stringify({ event })}\n\n`);
      send({ type: "text", text: "Refunds take " });
      send({ type: "text", text: "five days." });
      if (mode === "stream-error") {
        send({ type: "error", code: "AI_RUN_LIMIT" });
        return response.end();
      }
      send({ type: "sources", sources: [{ documentId: randomUUID(), title: "Handbook" }] });
      send({ type: "done", usage: { inputTokens: 10, outputTokens: 5 } });
      return response.end();
    }
    reply(404, { code: "NOT_FOUND", status: 404, params: {} });
  });
  await new Promise<void>((resolve) => ai.listen(0, "127.0.0.1", resolve));
  harness = await startApi(5, {
    AI_URL: `http://127.0.0.1:${(ai.address() as AddressInfo).port}`,
    AI_SERVICE_SECRET: SECRET,
  });
});

afterAll(async () => {
  await harness?.close();
  await new Promise((resolve) => ai?.close(resolve));
});

async function signedIn() {
  const session = createSession(harness);
  const email = newEmail();
  await session.auth("/sign-up/email", { email, password: newPassword(), name: "AI" });
  const { otp } = await takeOtp(harness, email);
  await session.auth("/email-otp/verify-email", { email, otp });
  return { session, email, me: await session.rpc.user.me() };
}

async function expectError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ORPCError);
  expect((error as ORPCError<string, unknown>).code).toBe(code);
}

/** Every event of a stream, from the promise that starts it. */
async function collect(start: Promise<AsyncIterable<unknown>>) {
  const events: unknown[] = [];
  for await (const event of await start) events.push(event);
  return events;
}

describe("AI features", () => {
  it("calls the service as the user, in their active workspace, with the request id", async () => {
    const { session, me } = await signedIn();
    await expect(session.rpc.ai.sentiment({ text: "great" })).resolves.toEqual({
      label: "positive",
      score: 0.9,
      model: "fake",
    });
    const call = calls.at(-1);
    expect(call).toMatchObject({
      path: "/v1/sentiment",
      user: me.id,
      org: me.activeOrganizationId,
      requestId: expect.any(String),
    });
  });

  it("adds, lists and removes documents, per workspace", async () => {
    const { session } = await signedIn();
    const added = await session.rpc.ai.addDocument({ title: "Handbook", content: "Refunds…" });
    expect(added).toMatchObject({
      title: "Handbook",
      status: "pending",
      summary: null,
      createdAt: expect.any(Date),
    });
    expect((await session.rpc.ai.documents()).map((d) => d.id)).toEqual([added.id]);

    const other = await signedIn();
    expect(await other.session.rpc.ai.documents()).toEqual([]);
    await expectError(
      other.session.rpc.ai.removeDocument({ documentId: added.id }),
      "DOCUMENT_NOT_FOUND",
    );
    await session.rpc.ai.removeDocument({ documentId: added.id });
    expect(await session.rpc.ai.documents()).toEqual([]);
  });

  it("members may remove only their own documents; admins any", async () => {
    const owner = await signedIn();
    const org = await owner.session.auth<{ id: string }>("/organization/create", {
      name: "Team",
      slug: `team-${randomUUID().slice(0, 8)}`,
    });
    await owner.session.auth("/organization/set-active", { organizationId: org.body.id });
    const member = await signedIn();
    await owner.session.auth("/organization/invite-member", {
      email: member.email,
      role: "member",
      organizationId: org.body.id,
    });
    const invitation = await takeNotification(harness, "org.invitation", member.email);
    await member.session.auth("/organization/accept-invitation", {
      invitationId: new URL(invitation.data.acceptUrl).pathname.split("/").at(-1),
    });
    await member.session.auth("/organization/set-active", { organizationId: org.body.id });

    const ownersDoc = await owner.session.rpc.ai.addDocument({ title: "Owner's", content: "x" });
    const membersDoc = await member.session.rpc.ai.addDocument({ title: "Member's", content: "x" });
    await expectError(
      member.session.rpc.ai.removeDocument({ documentId: ownersDoc.id }),
      "FORBIDDEN",
    );
    await member.session.rpc.ai.removeDocument({ documentId: membersDoc.id });
    const again = await member.session.rpc.ai.addDocument({
      title: "Member's again",
      content: "x",
    });
    await owner.session.rpc.ai.removeDocument({ documentId: again.id });
    expect((await owner.session.rpc.ai.documents()).map((d) => d.title)).toEqual(["Owner's"]);
  });

  it("streams an answer's events through, validated", async () => {
    const { session } = await signedIn();
    const events = await collect(session.rpc.ai.ask({ question: "Refunds?" }));
    expect(events).toEqual([
      { type: "text", text: "Refunds take " },
      { type: "text", text: "five days." },
      { type: "sources", sources: [{ documentId: expect.any(String), title: "Handbook" }] },
      { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
  });

  it("passes on an exhausted budget, and an answer stopped midway", async () => {
    const { session, me } = await signedIn();
    const org = me.activeOrganizationId as string;
    behaviour.set(org, "budget");
    await expectError(collect(session.rpc.ai.ask({ question: "Hi?" })), "AI_BUDGET_EXCEEDED");
    behaviour.set(org, "stream-error");
    const events = await collect(session.rpc.ai.ask({ question: "Hi?" }));
    expect(events.at(-1)).toEqual({ type: "error", code: "AI_RUN_LIMIT" });
  });

  it("hides the service's own failures behind UPSTREAM_UNAVAILABLE", async () => {
    const { session, me } = await signedIn();
    behaviour.set(me.activeOrganizationId as string, "down");
    await expectError(collect(session.rpc.ai.ask({ question: "Hi?" })), "UPSTREAM_UNAVAILABLE");
  });

  it("limits questions per user", async () => {
    const { session } = await signedIn();
    for (let i = 0; i < 20; i++) await collect(session.rpc.ai.ask({ question: `Q${i}?` }));
    await expectError(collect(session.rpc.ai.ask({ question: "One more?" })), "RATE_LIMITED");
  });

  it("validates input before calling the service", async () => {
    const { session } = await signedIn();
    const before = calls.length;
    await expectError(session.rpc.ai.addDocument({ title: "", content: "x" }), "VALIDATION_FAILED");
    await expectError(
      collect(session.rpc.ai.ask({ question: "x".repeat(2_001) })),
      "VALIDATION_FAILED",
    );
    expect(calls.length).toBe(before);
  });

  it("needs a session", async () => {
    await expectError(createSession(harness).rpc.ai.documents(), "UNAUTHENTICATED");
  });
});
