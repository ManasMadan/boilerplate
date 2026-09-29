"""A workspace's documents: stored, split into passages, embedded, and searched.

Adding a document stores its text and queues indexing (app/worker.py), so a large text
never holds up the request. Search is nearest-neighbour over the passages' embeddings,
limited to the caller's organization by row-level security.
"""

from dataclasses import dataclass
from uuid import UUID

from langgraph.graph.state import CompiledStateGraph  # pyright: ignore[reportMissingTypeStubs]
from redis.asyncio import Redis
from sqlalchemy import delete, func, select, update

from app.chunking import chunk
from app.contracts.ai_ingest_job import Meta
from app.db.models import Document, DocumentChunk
from app.db.session import tenant
from app.embeddings import Embedder
from app.errors import AppError
from app.log import log
from app.queues import IngestQueue
from app.realtime import publish_to_org
from app.settings import Settings
from app.summaries import SummaryState, build_summary_graph, local_summarizer, summarize
from app.usage import record, used_this_month

# Passages sent to the embedding model per request.
EMBED_BATCH = 64


@dataclass(frozen=True)
class Passage:
    document_id: UUID
    title: str
    content: str
    score: float


@dataclass(frozen=True)
class Summaries:
    """Summaries are written when a model is configured (see app/summaries.py)."""

    graph: CompiledStateGraph[SummaryState]
    model_name: str
    monthly_tokens: int


class Documents:
    def __init__(
        self,
        embedder: Embedder,
        queue: IngestQueue,
        redis: Redis,
        summaries: Summaries | None = None,
    ) -> None:
        self._embedder = embedder
        self._queue = queue
        self._redis = redis
        self._summaries = summaries

    async def create(
        self, org_id: UUID, user_id: UUID, title: str, content: str, request_id: str | None
    ) -> Document:
        async with tenant(org_id) as session:
            document = Document(
                org_id=org_id,
                created_by=user_id,
                title=title,
                content=content,
                updated_at=func.now(),
            )
            session.add(document)
            await session.flush()
            await session.refresh(document)
        await self._queue.add(
            document.id, org_id, Meta(requestId=request_id, userId=str(user_id), orgId=str(org_id))
        )
        await publish_to_org(self._redis, org_id, {"type": "documents.changed"})
        return document

    async def list(self, org_id: UUID) -> list[Document]:
        async with tenant(org_id) as session:
            rows = await session.scalars(
                select(Document)
                .where(Document.org_id == org_id)
                .order_by(Document.created_at.desc())
            )
            return list(rows)

    async def delete(self, org_id: UUID, document_id: UUID) -> None:
        async with tenant(org_id) as session:
            deleted = await session.scalar(
                delete(Document)
                .where(Document.id == document_id, Document.org_id == org_id)
                .returning(Document.id)
            )
            if deleted is None:
                raise AppError("DOCUMENT_NOT_FOUND", 404)
        await publish_to_org(self._redis, org_id, {"type": "documents.changed"})

    async def index(self, org_id: UUID, document_id: UUID, meta: Meta | None = None) -> None:
        """Splits and embeds a document (the ingest job). Safe to run again: it replaces
        the passages it wrote before."""
        async with tenant(org_id) as session:
            document = await session.get(Document, document_id)
            if not document:
                return  # deleted before it was indexed
            document.status = "indexing"
            content = document.content
        try:
            passages = chunk(content)
            vectors: list[list[float]] = []
            for start in range(0, len(passages), EMBED_BATCH):
                vectors.extend(await self._embedder.embed(passages[start : start + EMBED_BATCH]))
        except Exception:
            log.exception("indexing failed", document_id=str(document_id))
            async with tenant(org_id) as session:
                await session.execute(
                    update(Document)
                    .where(Document.id == document_id)
                    .values(
                        status="failed", error="DOCUMENT_INDEXING_FAILED", updated_at=func.now()
                    )
                )
            await publish_to_org(self._redis, org_id, {"type": "documents.changed"})
            raise
        async with tenant(org_id) as session:
            await session.execute(
                delete(DocumentChunk).where(DocumentChunk.document_id == document_id)
            )
            session.add_all(
                DocumentChunk(
                    document_id=document_id,
                    org_id=org_id,
                    ordinal=ordinal,
                    content=text,
                    embedding=vector,
                )
                for ordinal, (text, vector) in enumerate(zip(passages, vectors, strict=True))
            )
            await session.execute(
                update(Document)
                .where(Document.id == document_id)
                .values(
                    status="ready", error=None, chunk_count=len(passages), updated_at=func.now()
                )
            )
        await publish_to_org(self._redis, org_id, {"type": "documents.changed"})
        if self._summaries:
            await self._queue.add(document_id, org_id, meta or Meta(), name="summarize")

    async def summarize(self, org_id: UUID, document_id: UUID, user_id: UUID | None) -> None:
        """Writes the document's summary (the summarize job). A workspace past its monthly
        allowance simply gets no summary; answering questions matters more."""
        if not self._summaries:
            return
        if await used_this_month(org_id) >= self._summaries.monthly_tokens:
            log.info("skipping a summary: monthly budget used", document_id=str(document_id))
            return
        async with tenant(org_id) as session:
            passages = list(
                await session.scalars(
                    select(DocumentChunk.content)
                    .where(DocumentChunk.document_id == document_id)
                    .order_by(DocumentChunk.ordinal)
                )
            )
        summary, usage = await summarize(self._summaries.graph, passages)
        await record(
            org_id,
            user_id,
            "summary",
            self._summaries.model_name,
            usage.input_tokens,
            usage.output_tokens,
        )
        async with tenant(org_id) as session:
            await session.execute(
                update(Document)
                .where(Document.id == document_id)
                .values(summary=summary or None, updated_at=func.now())
            )
        await publish_to_org(self._redis, org_id, {"type": "documents.changed"})

    async def search(self, org_id: UUID, query: str, limit: int = 5) -> list[Passage]:
        [vector] = await self._embedder.embed([query])
        distance = DocumentChunk.embedding.cosine_distance(vector)
        async with tenant(org_id) as session:
            rows = await session.execute(
                select(DocumentChunk.document_id, Document.title, DocumentChunk.content, distance)
                .join(Document, Document.id == DocumentChunk.document_id)
                .where(
                    DocumentChunk.org_id == org_id,
                    Document.status == "ready",
                    distance <= 1 - self._embedder.min_score,
                )
                .order_by(distance)
                .limit(limit)
            )
            return [
                Passage(document_id=row[0], title=row[1], content=row[2], score=1 - float(row[3]))
                for row in rows
            ]


def create_summaries(settings: Settings) -> Summaries | None:
    if not settings.model:
        return None
    model = local_summarizer() if settings.model == "local:extractive" else settings.model
    return Summaries(
        graph=build_summary_graph(model, settings.tokens_per_run),
        model_name=settings.model,
        monthly_tokens=settings.monthly_tokens_per_org,
    )
