/**
 * Typed BullMQ producer.
 *
 *   const notifications = createProducer("notifications-critical", redis);
 *   await notifications.add("send", payload, { jobId: uuidv7() });
 *
 * The job name and payload are checked against `queues` at compile time and the
 * payload is validated at runtime before it is written to Redis.
 *
 * `jobId` is required and chosen by the producer (a UUIDv7, or the outbox event id):
 * BullMQ ignores a second add with the same id, so a retried request never enqueues
 * twice, and consumers use it as the idempotency key towards providers. BullMQ's own
 * auto-increment ids restart after a Redis flush and must never be used for that.
 */
import { type ConnectionOptions, type JobsOptions, Queue } from "bullmq";
import { z } from "zod";
import {
  type JobMeta,
  type JobName,
  type JobPayload,
  jobMeta,
  type QueueName,
  queuePrefix,
  queues,
} from "./queues";

/**
 * The payload schema for one job. TypeScript cannot relate an indexed lookup on a
 * generic key back to the generic payload type (a known limit with correlated
 * unions), so the narrowing happens once, here, where the key is checked at runtime.
 */
function schemaFor<Q extends QueueName, J extends JobName<Q>>(
  queue: Q,
  job: J,
): z.ZodType<JobPayload<Q, J>> {
  const jobs: Record<string, z.ZodType> = queues[queue].jobs;
  const schema = jobs[job];
  if (!schema) throw new Error(`Unknown job "${job}" on queue "${queue}"`);
  return schema as z.ZodType<JobPayload<Q, J>>;
}

export function createProducer<Q extends QueueName>(queue: Q, connection: ConnectionOptions) {
  const bull = new Queue(queue, {
    connection,
    prefix: queuePrefix(queue),
    defaultJobOptions: queues[queue].options,
  });
  return {
    queue: bull,
    async add<J extends JobName<Q>>(
      job: J,
      payload: JobPayload<Q, J>,
      { meta = {}, ...options }: Omit<JobsOptions, "jobId"> & { jobId: string; meta?: JobMeta },
    ) {
      return bull.add(
        job,
        { meta: jobMeta.parse(meta), payload: schemaFor(queue, job).parse(payload) },
        options,
      );
    },
    /** Many jobs in one round trip (same validation and required ids as `add`). */
    async addBulk<J extends JobName<Q>>(
      jobs: {
        name: J;
        payload: JobPayload<Q, J>;
        options: Omit<JobsOptions, "jobId"> & { jobId: string; meta?: JobMeta };
      }[],
    ) {
      return bull.addBulk(
        jobs.map(({ name, payload, options: { meta = {}, ...options } }) => ({
          name,
          data: { meta: jobMeta.parse(meta), payload: schemaFor(queue, name).parse(payload) },
          opts: options,
        })),
      );
    },
    close: () => bull.close(),
  };
}

export type Producer<Q extends QueueName> = ReturnType<typeof createProducer<Q>>;

/**
 * Validates a consumed job against its contract and returns its metadata and payload.
 * Throws (so the job fails and is kept for inspection) on any mismatch.
 */
export function parseJob<Q extends QueueName, J extends JobName<Q>>(
  queue: Q,
  job: J,
  data: unknown,
): { meta: JobMeta; payload: JobPayload<Q, J> } {
  const envelope = z.object({ meta: jobMeta, payload: z.unknown() }).parse(data);
  return { meta: envelope.meta, payload: schemaFor(queue, job).parse(envelope.payload) };
}
