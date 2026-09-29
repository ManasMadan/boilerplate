"""The queues this service uses, configured from packages/jobs (prefix and job options
come from app/contracts/queue_settings.json, generated from the TypeScript definitions,
so both languages agree on where jobs live and how they retry)."""

import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Protocol
from uuid import UUID

# bullmq ships no type stubs: its calls are confined to this module, behind typed wrappers.
from bullmq import Queue, Worker  # pyright: ignore[reportMissingTypeStubs]

from app.contracts.ai_ingest_job import AiIngestJob, Meta, Payload

SETTINGS: dict[str, dict[str, Any]] = json.loads(
    (Path(__file__).parent / "contracts" / "queue_settings.json").read_text()
)
INGEST = "ai-ingest"


def queue_options(name: str, redis_url: str) -> dict[str, Any]:
    return {"connection": redis_url, "prefix": SETTINGS[name]["prefix"]}


class IngestQueue:
    def __init__(self, redis_url: str) -> None:
        self._queue = Queue(INGEST, queue_options(INGEST, redis_url))  # pyright: ignore[reportArgumentType]

    async def add(self, document_id: UUID, org_id: UUID, meta: Meta) -> None:
        job = AiIngestJob(meta=meta, payload=Payload(documentId=document_id, orgId=org_id))
        await self._queue.add(  # pyright: ignore[reportUnknownMemberType]
            "ingest",
            job.model_dump(mode="json", exclude_none=True),
            # The document id: adding the same document twice indexes it once.
            {**SETTINGS[INGEST]["options"], "jobId": str(document_id)},  # pyright: ignore[reportArgumentType]
        )

    async def close(self) -> None:
        await self._queue.close()


class JobLike(Protocol):
    id: str | None
    data: Any


class RunningWorker(Protocol):
    async def close(self) -> None: ...


def start_worker(
    name: str,
    handle: Callable[[JobLike], Awaitable[None]],
    redis_url: str,
    concurrency: int,
) -> RunningWorker:
    async def process(job: JobLike, _token: str) -> None:
        await handle(job)

    opts: Any = {**queue_options(name, redis_url), "concurrency": concurrency}
    return Worker(name, process, opts)  # pyright: ignore[reportArgumentType, reportUnknownVariableType]
