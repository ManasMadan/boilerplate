import { Processor, WorkerHost } from "@nestjs/bullmq";
import { type NotificationPayload, parseJob, type QueueName, queuePrefix } from "@repo/jobs";
import type { Job } from "bullmq";
import { env } from "../env";
import { Dispatcher } from "./dispatcher";

/**
 * Consumers for both notification queues. They share the dispatcher but run in separate
 * worker pools with their own concurrency, so bulk sends never delay critical ones.
 * Failures throw: BullMQ retries with the queue's backoff and finally keeps the job in
 * the failed set for inspection and replay.
 */
async function handle(queue: QueueName, job: Job, dispatcher: Dispatcher) {
  if (job.name !== "send") throw new Error(`Unknown job "${job.name}" on ${queue}`);
  if (!job.id) throw new Error(`Job on ${queue} has no id; producers must set jobId`);
  const payload: NotificationPayload = parseJob(queue, "send", job.data);
  // The producer-chosen job id is stable across retries and Redis restarts.
  await dispatcher.dispatch(payload, job.id);
}

@Processor("notifications-critical", {
  concurrency: env.NOTIFICATIONS_CRITICAL_CONCURRENCY,
  prefix: queuePrefix("notifications-critical"),
})
export class CriticalNotificationsProcessor extends WorkerHost {
  constructor(private readonly dispatcher: Dispatcher) {
    super();
  }
  process(job: Job) {
    return handle("notifications-critical", job, this.dispatcher);
  }
}

@Processor("notifications-bulk", {
  concurrency: env.NOTIFICATIONS_BULK_CONCURRENCY,
  prefix: queuePrefix("notifications-bulk"),
})
export class BulkNotificationsProcessor extends WorkerHost {
  constructor(private readonly dispatcher: Dispatcher) {
    super();
  }
  process(job: Job) {
    return handle("notifications-bulk", job, this.dispatcher);
  }
}
