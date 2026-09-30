/**
 * The AI features, on top of the Python service through its generated client
 * (packages/ai-client). This API has authenticated the user and checked their
 * membership; each call to the service carries a token naming them and the workspace.
 *
 * Service errors are mapped to this API's error codes; anything unexpected becomes
 * UPSTREAM_UNAVAILABLE, never the service's own message.
 */

import { Injectable } from "@nestjs/common";
import { type AiCaller, AiServiceError, createAiClient } from "@repo/ai-client";
import type { AiDocument, AssistantEvent } from "@repo/contracts/api";
import { type ErrorCode, isErrorCode } from "@repo/contracts/errors";
import { canManageWorkspace, type OrgRole } from "@repo/contracts/roles";
import {
  AppError,
  createRateLimiter,
  currentContext,
  InjectRedis,
  type Redis,
} from "@repo/nest-common";
import { env } from "../../env";

// Error codes the service may answer with that clients understand.
const PASSED_ON = new Set<ErrorCode>([
  "DOCUMENT_NOT_FOUND",
  "AI_BUDGET_EXCEEDED",
  "FEATURE_DISABLED",
  "VALIDATION_FAILED",
]);

@Injectable()
export class AiService {
  private readonly client =
    env.AI_URL && env.AI_SERVICE_SECRET
      ? createAiClient({ baseUrl: env.AI_URL, secret: env.AI_SERVICE_SECRET })
      : null;
  private readonly questions;
  private readonly uploads;

  constructor(@InjectRedis() redis: Redis) {
    this.questions = createRateLimiter(redis, {
      name: "ai-questions",
      points: 20,
      windowSeconds: 60,
    });
    this.uploads = createRateLimiter(redis, {
      name: "ai-documents",
      points: 30,
      windowSeconds: 60 * 60,
    });
  }

  private get ai() {
    if (!this.client) throw new AppError("FEATURE_DISABLED", { params: { feature: "ai" } });
    return this.client;
  }

  private caller(userId: string, orgId: string): AiCaller {
    return { userId, orgId, requestId: currentContext()?.requestId };
  }

  private async limit(limiter: typeof this.questions, key: string) {
    const result = await limiter.consume(key);
    if (!result.allowed) {
      throw new AppError("RATE_LIMITED", {
        params: { retryAfterSeconds: result.retryAfterSeconds },
      });
    }
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw toAppError(error);
    }
  }

  sentiment(userId: string, orgId: string, text: string) {
    return this.call(() => this.ai.sentiment(this.caller(userId, orgId), text));
  }

  async documents(userId: string, orgId: string): Promise<AiDocument[]> {
    const rows = await this.call(() => this.ai.listDocuments(this.caller(userId, orgId)));
    return rows.map(toDocument);
  }

  async addDocument(userId: string, orgId: string, input: { title: string; content: string }) {
    await this.limit(this.uploads, userId);
    const row = await this.call(() => this.ai.createDocument(this.caller(userId, orgId), input));
    return toDocument(row);
  }

  /** A member may remove their own documents; owners and admins any. */
  async removeDocument(userId: string, orgId: string, role: OrgRole, documentId: string) {
    if (!canManageWorkspace(role)) {
      const document = (await this.documents(userId, orgId)).find((d) => d.id === documentId);
      if (!document) throw new AppError("DOCUMENT_NOT_FOUND");
      if (document.createdBy !== userId) throw new AppError("FORBIDDEN");
    }
    await this.call(() => this.ai.deleteDocument(this.caller(userId, orgId), documentId));
  }

  /**
   * Starts an answer: limits, budget and an unavailable service are refused here, as
   * typed errors, before the stream begins. A failure midway (the connection drops)
   * ends the stream with an `error` event, which the contract has for exactly that.
   */
  async ask(
    userId: string,
    orgId: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<AssistantEvent>> {
    await this.limit(this.questions, userId);
    const stream = await this.call(() =>
      this.ai.answer(this.caller(userId, orgId), question, signal),
    );
    return (async function* () {
      try {
        yield* stream;
      } catch {
        if (signal?.aborted) return; // the client went away
        yield { type: "error", code: "UPSTREAM_UNAVAILABLE" } as const;
      }
    })();
  }
}

function toDocument(row: {
  id: string;
  title: string;
  status: AiDocument["status"];
  error: string | null;
  chunkCount: number;
  summary: string | null;
  createdBy: string | null;
  createdAt: string;
}): AiDocument {
  return { ...row, createdAt: new Date(row.createdAt) };
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof AiServiceError && isErrorCode(error.code) && PASSED_ON.has(error.code)) {
    return new AppError(error.code, { params: error.params as Record<string, string | number> });
  }
  return new AppError("UPSTREAM_UNAVAILABLE", { params: { service: "ai" }, cause: error });
}
