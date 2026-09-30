/**
 * Failed jobs: what went wrong, and putting them back once the cause is fixed. BullMQ
 * keeps a queue's failed jobs (`removeOnFail` in queues.ts: 30 days for most queues),
 * so that set is the dead-letter queue; `bun run jobs` (scripts/jobs.ts) drives these
 * against any environment's Valkey.
 *
 * A retried job starts over with its full retry schedule. Consumers are idempotent on
 * the job id, so retrying something that half-succeeded is safe.
 */
import type { Queue } from "bullmq";

export interface FailedJob {
  id: string;
  name: string;
  attemptsMade: number;
  failedReason: string;
  failedAt: Date | null;
  data: unknown;
}

/** The most recently failed jobs first. */
export async function failedJobs(queue: Queue<unknown>, limit = 50): Promise<FailedJob[]> {
  const jobs = await queue.getFailed(0, limit - 1);
  return jobs.map((job) => ({
    // A job read back from a queue always has its id (it's in the key).
    id: job.id as string,
    name: job.name,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    failedAt: job.finishedOn ? new Date(job.finishedOn) : null,
    data: job.data,
  }));
}

/**
 * Moves failed jobs back to waiting: the given ids, or every failed job. Returns how
 * many moved; an id that isn't failed (already retried, or removed) is skipped.
 */
export async function retryFailed(queue: Queue, ids?: readonly string[]): Promise<number> {
  const targets = ids ?? (await allFailedIds(queue));
  let moved = 0;
  for (const id of targets) {
    const job = await queue.getJob(id);
    if (!job || !(await job.isFailed())) continue;
    await job.retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true });
    moved += 1;
  }
  return moved;
}

/** Deletes failed jobs that should never run (a payload a code change made obsolete). */
export async function discardFailed(queue: Queue, ids: readonly string[]): Promise<number> {
  let removed = 0;
  for (const id of ids) {
    const job = await queue.getJob(id);
    if (!job || !(await job.isFailed())) continue;
    await job.remove();
    removed += 1;
  }
  return removed;
}

async function allFailedIds(queue: Queue) {
  const ids: string[] = [];
  const page = 500;
  for (let start = 0; ; start += page) {
    const jobs = await queue.getFailed(start, start + page - 1);
    ids.push(...jobs.map((job) => job.id as string));
    if (jobs.length < page) return ids;
  }
}
