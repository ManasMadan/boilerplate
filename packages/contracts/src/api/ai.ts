import { z } from "zod";
import { base } from "./base";

// Must not exceed the Python model's max_length (apps/ai/app/schemas.py); a test in
// apps/api compares the two through the generated AI client schema.
export const SENTIMENT_TEXT_MAX_LENGTH = 5_000;

export const aiContract = {
  sentiment: base
    .route({
      method: "POST",
      path: "/ai/sentiment",
      tags: ["AI"],
      summary: "Classify the sentiment of a text",
    })
    .input(z.object({ text: z.string().trim().min(1).max(SENTIMENT_TEXT_MAX_LENGTH) }))
    .output(
      z.object({
        label: z.enum(["positive", "negative", "neutral"]),
        score: z.number().min(0).max(1),
        model: z.string(),
      }),
    ),
};
