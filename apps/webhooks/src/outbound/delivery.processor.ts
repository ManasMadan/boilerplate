/**
 * Consumes webhook-deliveries. Retries use the Standard Webhooks schedule through a
 * custom backoff (WEBHOOK_RETRY_DELAYS_MS), so a job's attempts map to delivery attempts.
 */
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

@Processor("webhook-deliveries", {
  concurrency: env.WEBHOOK_DELIVERY_CONCURRENCY,
  prefix: queuePrefix("webhook-deliveries"),
  settings: {
    backoffStrategy: (attemptsMade: number) =>
      WEBHOOK_RETRY_DELAYS_MS[attemptsMade - 1] ?? (WEBHOOK_RETRY_DELAYS_MS.at(-1) as number),
  },
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

  async process(job: Job) {
    const meta = {
      requestId: `job:${job.id}`,
      ...parseJob("webhook-deliveries", job.name as JobName<"webhook-deliveries">, job.data).meta,
    };
    await runWithContext(meta, () => this.handle(job));
  }

  private async handle(job: Job) {
    switch (job.name as JobName<"webhook-deliveries">) {
      case "deliver": {
        const { deliveryId, orgId } = parseJob("webhook-deliveries", "deliver", job.data).payload;
        const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
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
        const deliveryId = await this.deliveries.createTest(orgId, endpointId);
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
