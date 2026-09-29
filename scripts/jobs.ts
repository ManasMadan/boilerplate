/**
 * The queues at a glance, and their failed jobs listed, retried or discarded
 * (packages/jobs/src/admin.ts):
 *
 *   bun run jobs                          waiting, active, delayed and failed per queue
 *   bun run jobs failed <queue> [limit]   the latest failed jobs and why
 *   bun run jobs retry <queue> [ids…]     retry those, or every failed job of the queue
 *   bun run jobs discard <queue> <ids…>   delete failed jobs that must never run
 *
 * Uses REDIS_URL (.env). For a deployed environment, forward its Valkey and point at it:
 *   kubectl -n boilerplate port-forward svc/boilerplate-data-valkey 56380:6379
 *   REDIS_URL=redis://:<password from the valkey Secret>@localhost:56380 bun run jobs
 * Fix the cause before retrying: a job retried into the same failure fails again.
 */

import { type QueueName, queuePrefix, queues } from "@repo/jobs";
import { discardFailed, failedJobs, retryFailed } from "@repo/jobs/admin";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { fail } from "./lib";

const [command = "status", name, ...rest] = process.argv.slice(2);
const url = process.env.REDIS_URL;
if (!url) {
  fail("REDIS_URL isn't set (bun run setup writes it to .env)");
  process.exit(1);
}
const connection = new Redis(url, { maxRetriesPerRequest: null });
const names = Object.keys(queues) as QueueName[];
const open = (queue: QueueName) => new Queue(queue, { connection, prefix: queuePrefix(queue) });

function queueNamed(value: string | undefined) {
  if (!value || !names.includes(value as QueueName)) {
    fail(`Name a queue: ${names.join(", ")}`);
    process.exit(1);
  }
  return open(value as QueueName);
}

try {
  if (command === "status") {
    for (const queueName of names) {
      const queue = open(queueName);
      const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
      const marker = counts.failed ? "  ← failed jobs" : "";
      console.log(
        `${queueName.padEnd(24)} waiting ${counts.waiting}  active ${counts.active}  delayed ${counts.delayed}  failed ${counts.failed}${marker}`,
      );
      await queue.close();
    }
  } else if (command === "failed") {
    const queue = queueNamed(name);
    const jobs = await failedJobs(queue, Number(rest[0] ?? 20));
    if (jobs.length === 0) console.log("No failed jobs.");
    for (const job of jobs) {
      console.log(
        `${job.id}  ${job.name}  ${job.failedAt?.toISOString() ?? "?"}  after ${job.attemptsMade} attempts\n  ${job.failedReason}`,
      );
    }
    await queue.close();
  } else if (command === "retry") {
    const queue = queueNamed(name);
    console.log(`Retried ${await retryFailed(queue, rest.length ? rest : undefined)} jobs.`);
    await queue.close();
  } else if (command === "discard") {
    const queue = queueNamed(name);
    if (rest.length === 0) {
      fail("Name the job ids to discard (see `bun run jobs failed <queue>`).");
      process.exit(1);
    }
    console.log(`Discarded ${await discardFailed(queue, rest)} jobs.`);
    await queue.close();
  } else {
    fail(`Unknown command "${command}": status, failed, retry or discard.`);
    process.exitCode = 1;
  }
} finally {
  await connection.quit();
}
