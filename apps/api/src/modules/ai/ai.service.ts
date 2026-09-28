/**
 * Calls the Python AI service through its generated, typed client (packages/ai-client).
 * The response type comes from the Pydantic models in apps/ai.
 */
import { Injectable } from "@nestjs/common";
import { createAiClient } from "@repo/ai-client";
import { AppError } from "@repo/nest-common";
import { env } from "../../env";

@Injectable()
export class AiService {
  private readonly client = env.AI_URL ? createAiClient(env.AI_URL) : null;

  async sentiment(text: string) {
    if (!this.client) throw new AppError("FEATURE_DISABLED", { params: { feature: "ai" } });
    const { data, error, response } = await this.client
      .POST("/v1/sentiment", { body: { text } })
      .catch((cause: unknown) => {
        throw new AppError("UPSTREAM_UNAVAILABLE", { params: { service: "ai" }, cause });
      });
    if (error || !data) {
      throw new AppError("UPSTREAM_UNAVAILABLE", {
        params: { service: "ai", status: response.status },
        cause: error,
      });
    }
    return data;
  }
}
