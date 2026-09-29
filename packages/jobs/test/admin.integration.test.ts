/** Failed jobs, listed and put back, on a real Valkey. */
import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discardFailed, failedJobs, retryFailed } from "../src/admin";

// Database 12 (shared with nest-common's suite, which never flushes it) under a prefix
// of this run's own, so nothing else's keys are touched.
const url = new URL(process.env.REDIS_URL ?? "redis://localhost:56379");
url.pathname = "/12";
const connection = new Redis(url.toString(), { maxRetriesPerRequest: null });
const prefix = `test-admin-${randomUUID()}`;
const queue = new Queue("jobs-admin", { connection, prefix });
/** Fails a job until it's told to succeed. */
let succeed = false;
const handled: string[] = [];
let worker: Worker;

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check()) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return check();
}

beforeAll(async () => {
  worker = new Worker(
    "jobs-admin",
    async (job) => {
      if (!succeed) throw new Error(`provider down (${job.data.n})`);
      handled.push(job.id ?? "");
    },
    { connection, prefix },
  );
  for (const n of [1, 2, 3]) await queue.add("send", { n }, { jobId: `job-${n}`, attempts: 2 });
  expect(await until(async () => (await queue.getFailedCount()) === 3)).toBe(true);
});

afterAll(async () => {
  await worker?.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await connection.quit();
});

describe("failed jobs", () => {
  it("lists what failed and why, after every attempt was used", async () => {
    const failed = await failedJobs(queue);
    expect(failed.map((job) => job.id).sort()).toEqual(["job-1", "job-2", "job-3"]);
    expect(failed[0]).toMatchObject({
      name: "send",
      attemptsMade: 2,
      failedReason: expect.stringMatching(/provider down/),
      failedAt: expect.any(Date),
    });
    expect(await failedJobs(queue, 1)).toHaveLength(1);
  });

  it("discards one that should never run, and retries a chosen one with a fresh budget", async () => {
    expect(await discardFailed(queue, ["job-3", "missing"])).toBe(1);
    succeed = true;
    expect(await retryFailed(queue, ["job-1", "missing"])).toBe(1);
    expect(await until(async () => handled.includes("job-1"))).toBe(true);
    // A job that isn't failed any more is skipped.
    expect(await retryFailed(queue, ["job-1"])).toBe(0);
  });

  it("retries every failed job", async () => {
    expect(await retryFailed(queue)).toBe(1);
    expect(await until(async () => handled.includes("job-2"))).toBe(true);
    expect(await queue.getFailedCount()).toBe(0);
    expect(await queue.getJob("job-3")).toBeUndefined();
  });
});
