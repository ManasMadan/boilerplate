"""Request/response models.

These Pydantic models are the contract with the TypeScript side. FastAPI turns them
into `openapi.json`, which `packages/ai-client` turns into TypeScript types. So a field
you add here shows up, typed, in `apps/api` after `bun run gen`.

Constrain every field (lengths, ranges, enums). The constraints are enforced at
runtime by Pydantic *and* end up in the OpenAPI schema as documentation.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class SentimentRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5_000, description="Text to classify.")


class SentimentResponse(BaseModel):
    label: Literal["positive", "negative", "neutral"]
    score: float = Field(ge=0, le=1, description="Confidence of the predicted label.")
    model: str = Field(description="Identifier of the model that produced the prediction.")


class HealthResponse(BaseModel):
    status: Literal["ok"]


class DocumentCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=200_000, description="Plain text.")


class DocumentOut(BaseModel):
    id: UUID
    title: str
    status: Literal["pending", "indexing", "ready", "failed"]
    error: str | None
    chunkCount: int
    summary: str | None
    createdBy: UUID | None
    createdAt: datetime
