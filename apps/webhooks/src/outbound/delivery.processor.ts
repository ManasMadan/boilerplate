/**
 * Consumes webhook-deliveries. Retries use the Standard Webhooks schedule through a
 * custom backoff (WEBHOOK_RETRY_DELAYS_MS), so a job's attempts map to delivery attempts.
 */
import { randomUUID } from "node:crypto";
import { Processor } from "@nestjs/bullmq";
import {
  createProducer,
  type JobName,
  parseJob,
  queuePrefix,
  WEBHOOK_RETRY_DELAYS_MS,
} from "@repo/jobs";
import { InjectRedis, JobProcessor, type Redis, runWithContext } from "@repo/nest-common";
import type { Job } from "bullmq";
import { env } from "../env";
import { DeliveryService } from "./delivery.service";

/** Thrown to make BullMQ schedule the next attempt; the outcome is already recorded. */
class DeliveryFailed extends Error {}

/** How long to wait after a failed attempt: the schedule's step, never past its last. */
export const retryDelayMs = (attemptsMade: number) =>
  WEBHOOK_RETRY_DELAYS_MS[attemptsMade - 1] ?? (WEBHOOK_RETRY_DELAYS_MS.at(-1) as number);

@Processor("webhook-deliveries", {
  concurrency: env.WEBHOOK_DELIVERY_CONCURRENCY,
  prefix: queuePrefix("webhook-deliveries"),
  settings: { backoffStrategy: retryDelayMs },
})
export class DeliveryProcessor extends JobProcessor {
  private readonly queue;

  constructor(
    private readonly deliveries: DeliveryService,
    @InjectRedis() redis: Redis,
  ) {
    super();
    this.queue = createProducer("webhook-deliveries", redis);
  }

  async process(job: Job<unknown>) {
    const meta = {
      requestId: `job:${job.id}`,
      ...parseJob("webhook-deliveries", job.name as JobName<"webhook-deliveries">, job.data).meta,
    };
    await runWithContext(meta, () => this.handle(job));
  }

  private async handle(job: Job<unknown>) {
    switch (job.name as JobName<"webhook-deliveries">) {
      case "deliver": {
        const { deliveryId, orgId } = parseJob("webhook-deliveries", "deliver", job.data).payload;
        // BullMQ sets attempts on every job (0 when none were asked for).
        const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts as number);
        const outcome = await this.deliveries.attempt(orgId, deliveryId, isLastAttempt);
        if (outcome === "retry")
          throw new DeliveryFailed(`delivery ${deliveryId} failed; retrying`);
        return;
      }
      case "redeliver": {
        const { deliveryId, orgId } = parseJob("webhook-deliveries", "redeliver", job.data).payload;
        if (await this.deliveries.reset(orgId, deliveryId)) {
          // A fresh job id per replay (BullMQ ids can't contain ":").
          await this.enqueue(deliveryId, orgId, `${deliveryId}-replay-${job.id}`);
        }
        return;
      }
      case "send-test": {
        const { endpointId, orgId } = parseJob("webhook-deliveries", "send-test", job.data).payload;
        // Keyed on the job: a retried send-test finds its delivery instead of adding one.
        const deliveryId = await this.deliveries.createTest(orgId, endpointId, testEventId(job.id));
        await this.enqueue(deliveryId, orgId, deliveryId);
        return;
      }
    }
  }

  private enqueue(deliveryId: string, orgId: string, jobId: string) {
    return this.queue.add("deliver", { deliveryId, orgId }, { jobId, meta: { orgId } });
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The test event's id: the job's own (the api gives each send-test a UUID), else a new one. */
const testEventId = (jobId: string | undefined) =>
  jobId && UUID.test(jobId) ? jobId : randomUUID();
