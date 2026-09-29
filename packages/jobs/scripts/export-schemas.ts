/**
 * Writes the contracts the Python service shares as JSON Schema (generated/schemas,
 * committed), and the shared queues' Redis prefix and job options
 * (generated/queue-settings.json).
 * apps/ai turns them into Pydantic models, so a payload is defined once, in zod, and
 * both languages validate the same shape; CI fails if the committed files drift.
 *
 * Add an entry here when a Python service produces or consumes a queue or message.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realtimeMessage } from "@repo/contracts/realtime";
import { z } from "zod";
import { jobMeta, queuePrefix, queues } from "../src/queues";

const out = join(import.meta.dirname, "..", "generated", "schemas");
mkdirSync(out, { recursive: true });

// File name (the Python module) → title (the Pydantic class) and schema.
const schemas: Record<string, [string, z.ZodType]> = {
  ai_ingest_job: [
    "AiIngestJob",
    z.object({ meta: jobMeta, payload: queues["ai-ingest"].jobs.ingest }),
  ],
  realtime_message: ["RealtimeMessage", realtimeMessage],
};

for (const [file, [title, schema]] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    // A uuid's format says it all; the regex zod adds too can't apply to Python's UUID type.
    override: ({ jsonSchema }) => {
      if (jsonSchema.format === "uuid") delete jsonSchema.pattern;
    },
  });
  writeFileSync(join(out, `${file}.json`), `${JSON.stringify({ title, ...json }, null, 2)}\n`);
}

// The queues Python uses, with the same Redis prefix and job options as TypeScript's.
const shared = ["ai-ingest"] as const;
const settings = Object.fromEntries(
  shared.map((name) => [name, { prefix: queuePrefix(name), options: queues[name].options }]),
);
writeFileSync(join(out, "..", "queue-settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
