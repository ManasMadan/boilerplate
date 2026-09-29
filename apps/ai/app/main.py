"""FastAPI entrypoint for the AI service.

Internal: only apps/api calls it, with a typed client generated from this app's OpenAPI
schema (packages/ai-client) and a short-lived token naming the user and organization
(app/auth.py). Browsers never reach it, so end-user auth, rate limits and input limits
stay in the API.

Long work (indexing documents) runs in app/worker.py from the `ai-ingest` queue.
"""

from collections.abc import AsyncGenerator, AsyncIterator, Awaitable
from contextlib import asynccontextmanager
from typing import Annotated, cast
from uuid import UUID

from fastapi import Depends, FastAPI, Request, Response
from fastapi.responses import StreamingResponse
from redis.asyncio import Redis
from sqlalchemy import text

from app import model
from app.assistant import Assistant, AssistantEvent, AssistantRequest, create_agent, create_model
from app.auth import CallerDep
from app.db.models import Document
from app.db.session import close_engine, engine, open_engine
from app.documents import Documents
from app.embeddings import create_embedder
from app.errors import AppError, install_error_handlers
from app.log import configure_logging
from app.queues import IngestQueue
from app.schemas import (
    DocumentCreate,
    DocumentOut,
    HealthResponse,
    SentimentRequest,
    SentimentResponse,
)
from app.settings import get_settings


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
    settings = get_settings()
    configure_logging(settings.log_level, json=settings.node_env == "production")
    open_engine(settings.database_url, settings.database_pool_max)
    redis = Redis.from_url(str(settings.redis_url))  # pyright: ignore[reportUnknownMemberType]
    queue = IngestQueue(str(settings.redis_url))
    documents = Documents(create_embedder(settings.embeddings), queue, redis)
    app.state.redis = redis
    app.state.documents = documents
    app.state.assistant = (
        Assistant(
            create_agent(create_model(settings.model, settings.fallback_model)),
            documents,
            model_name=settings.model,
            monthly_tokens=settings.monthly_tokens_per_org,
            tokens_per_run=settings.tokens_per_run,
        )
        if settings.model
        else None
    )
    yield
    await queue.close()
    await redis.aclose()
    await close_engine()


app = FastAPI(title="ai", version="0.1.0", lifespan=lifespan)
install_error_handlers(app)


def _documents(request: Request) -> Documents:
    return request.app.state.documents


def _assistant(request: Request) -> Assistant:
    assistant: Assistant | None = request.app.state.assistant
    if not assistant:
        raise AppError("FEATURE_DISABLED", 404, {"feature": "assistant"})
    return assistant


DocumentsDep = Annotated[Documents, Depends(_documents)]
AssistantDep = Annotated[Assistant, Depends(_assistant)]


def _out(document: Document) -> DocumentOut:
    return DocumentOut(
        id=document.id,
        title=document.title,
        status=document.status,  # pyright: ignore[reportArgumentType]  # checked by the database
        error=document.error,
        chunkCount=document.chunk_count,
        createdBy=document.created_by,
        createdAt=document.created_at,
    )


@app.get("/health/live", operation_id="live")
def live() -> HealthResponse:
    return HealthResponse(status="ok")


@app.get("/health/ready", operation_id="ready")
async def ready(request: Request) -> HealthResponse:
    async with engine().connect() as connection:
        await connection.execute(text("SELECT 1"))
    redis: Redis = request.app.state.redis
    # redis-py types the async client's ping as returning bool.
    await cast(Awaitable[bool], redis.ping())  # pyright: ignore[reportUnknownMemberType]
    return HealthResponse(status="ok")


# `operation_id` becomes the operation name in the generated TypeScript client.
# Plain `def`: inference is blocking work, so FastAPI runs it in a thread pool.
@app.post("/v1/sentiment", operation_id="sentiment")
def sentiment(body: SentimentRequest, _caller: CallerDep) -> SentimentResponse:
    label, score = model.predict(body.text)
    return SentimentResponse(label=label, score=score, model=model.MODEL_ID)


@app.get("/v1/documents", operation_id="listDocuments")
async def list_documents(caller: CallerDep, documents: DocumentsDep) -> list[DocumentOut]:
    return [_out(d) for d in await documents.list(caller.org_id)]


@app.post("/v1/documents", operation_id="createDocument", status_code=201)
async def create_document(
    body: DocumentCreate, caller: CallerDep, documents: DocumentsDep, request: Request
) -> DocumentOut:
    document = await documents.create(
        caller.org_id,
        caller.user_id,
        body.title,
        body.content,
        request.headers.get("x-request-id"),
    )
    return _out(document)


@app.delete("/v1/documents/{document_id}", operation_id="deleteDocument", status_code=204)
async def delete_document(
    document_id: UUID, caller: CallerDep, documents: DocumentsDep
) -> Response:
    await documents.delete(caller.org_id, document_id)
    return Response(status_code=204)


@app.post(
    "/v1/assistant/answers",
    operation_id="answer",
    response_class=StreamingResponse,
    responses={
        200: {
            "description": "Server-sent events, each `data:` line one AssistantEvent.",
            "model": AssistantEvent,
            "content": {"text/event-stream": {}},
        }
    },
)
async def answer(
    body: AssistantRequest, caller: CallerDep, assistant: AssistantDep
) -> StreamingResponse:
    # Checked before streaming starts, so an exhausted budget is a normal error response.
    await assistant.check_budget(caller.org_id)

    async def events() -> AsyncIterator[str]:
        async for event in assistant.answer(caller.org_id, caller.user_id, body.question):
            yield f"data: {event.model_dump_json()}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"cache-control": "no-cache, no-transform", "x-accel-buffering": "no"},
    )
