"""Turning text into vectors for retrieval, behind one interface.

`ProviderEmbedder` uses any embedding model Pydantic AI knows ("openai:text-embedding-3-
small", Cohere, Voyage, a local server), asked for 1536 dimensions. `HashingEmbedder`
needs no model or key: it hashes words into the same 1536 dimensions, so similar wording
lands close together. It's lexical, not semantic: development and tests only (settings
refuse it in production).

Changing the dimension means a migration (ai.chunk's vector column) and re-indexing
every document (documents keep their text for that).
"""

import hashlib
import math
import re
from typing import Protocol

from pydantic_ai import Embedder as PydanticEmbedder

from app.db.models import EMBEDDING_DIMENSIONS


class Embedder(Protocol):
    name: str

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


_WORD = re.compile(r"[\w']+")


class HashingEmbedder:
    name = "hashing"

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._one(text) for text in texts]

    @staticmethod
    def _one(text: str) -> list[float]:
        vector = [0.0] * EMBEDDING_DIMENSIONS
        for word in _WORD.findall(text.lower()):
            digest = hashlib.blake2b(word.encode(), digest_size=8).digest()
            index = int.from_bytes(digest[:4], "big") % EMBEDDING_DIMENSIONS
            vector[index] += 1.0 if digest[4] & 1 else -1.0
        norm = math.sqrt(sum(v * v for v in vector)) or 1.0
        return [v / norm for v in vector]


class ProviderEmbedder:
    def __init__(self, model: str) -> None:
        self.name = model
        self._embedder = PydanticEmbedder(model, settings={"dimensions": EMBEDDING_DIMENSIONS})

    async def embed(self, texts: list[str]) -> list[list[float]]:
        result = await self._embedder.embed_documents(texts)
        return [list(vector) for vector in result.embeddings]


def create_embedder(model: str) -> Embedder:
    return HashingEmbedder() if model == "hashing" else ProviderEmbedder(model)
