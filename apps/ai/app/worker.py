"""Background jobs for the AI service: indexing documents (queue `ai-ingest`).

Run with `bun run worker` (apps/ai). Jobs are validated against the shared contract
before they're processed, and restore the request id they were queued with, so logs
line up with the request that caused them. A failure throws, and BullMQ retries with
the queue's backoff (the same settings the TypeScript side uses).
"""

import asyncio
import signal
from uuid import UUID

import structlog
from redis.asyncio import Redis

from app.contracts.ai_ingest_job import AiIngestJob
from app.db.session import close_engine, open_engine
from app.documents import Documents, create_summaries
from app.embeddings import create_embedder
from app.log import configure_logging, log
from app.queues import INGEST, IngestQueue, JobLike, start_worker
from app.settings import get_settings


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, json=settings.node_env == "production")
    open_engine(settings.database_url, settings.database_pool_max)
    redis = Redis.from_url(str(settings.redis_url))  # pyright: ignore[reportUnknownMemberType]
    queue = IngestQueue(str(settings.redis_url))
    documents = Documents(
        create_embedder(settings.embeddings, settings.min_relevance),
        queue,
        redis,
        create_summaries(settings),
    )

    async def process(job: JobLike) -> None:
        data = AiIngestJob.model_validate(job.data)
        structlog.contextvars.bind_contextvars(
            request_id=data.meta.requestId or f"job:{job.id}", org_id=str(data.payload.orgId)
        )
        if job.name == "ingest":
            await documents.index(data.payload.orgId, data.payload.documentId, data.meta)
        elif job.name == "summarize":
            user = data.meta.userId
            await documents.summarize(
                data.payload.orgId, data.payload.documentId, UUID(user) if user else None
            )
        else:
            raise ValueError(f"unknown job {job.name!r} on {INGEST}")
        structlog.contextvars.clear_contextvars()

    worker = start_worker(INGEST, process, str(settings.redis_url), concurrency=4)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    log.info("ai worker started", queue=INGEST)
    await stop.wait()
    await worker.close()
    await queue.close()
    await redis.aclose()
    await close_engine()


if __name__ == "__main__":
    asyncio.run(main())
