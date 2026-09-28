"""FastAPI entrypoint for the AI service.

This service is internal: only apps/api calls it (with a typed client generated from
this app's OpenAPI schema). Browsers never talk to it directly, so auth, rate limiting
and input limits for end users stay in one place (the tRPC layer).
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import model
from app.schemas import HealthResponse, SentimentRequest, SentimentResponse


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
    # Load models, open connections, warm caches here: once per process, not per request.
    yield


app = FastAPI(title="ai", version="0.1.0", lifespan=lifespan)


@app.get("/health", operation_id="health")
def health() -> HealthResponse:
    return HealthResponse(status="ok")


# `operation_id` becomes the operation name in the generated TypeScript types.
# Plain `def` (not async): inference is blocking work, so FastAPI runs it in a thread pool.
@app.post("/v1/sentiment", operation_id="sentiment")
def sentiment(body: SentimentRequest) -> SentimentResponse:
    label, score = model.predict(body.text)
    return SentimentResponse(label=label, score=score, model=model.MODEL_ID)
