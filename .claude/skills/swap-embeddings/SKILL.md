---
name: swap-embeddings
description: Change the embedding model used to index and search documents (OpenAI, Cohere, Voyage, a local server). Use when retrieval quality is poor, the user wants a different or cheaper embedding model, or asks about vector dimensions.
---

# Swap the embedding model

- **Interface:** `Embedder` (`name`, `min_score`, `embed(texts)`) in
  `apps/ai/app/embeddings.py`.
- **Today:** `HashingEmbedder` locally (lexical, no model; refused in production) and
  `ProviderEmbedder` for any Pydantic AI embedding model, asked for
  `EMBEDDING_DIMENSIONS` (1536, `apps/ai/app/db/models.py`). `create_embedder` picks one.
- **Env:** `AI_EMBEDDINGS` (`hashing` or a model name such as
  `openai:text-embedding-3-small`), `AI_MIN_RELEVANCE` (cosine floor), and the provider's
  key (e.g. `OPENAI_API_KEY`).

## Swap

1. Same dimension (1536): set `AI_EMBEDDINGS` and the key, then re-index every document
   (vectors from different models aren't comparable; documents keep their text).
2. A different dimension: a migration changing `ai.chunk`'s vector column and its HNSW
   index (db-change skill), `EMBEDDING_DIMENSIONS` in `apps/ai/app/db/models.py`, and a
   re-index.
3. A model Pydantic AI can't reach: a class with the `Embedder` shape, chosen in
   `create_embedder`.
4. Calibrate `AI_MIN_RELEVANCE` for the new model with `bun run --cwd apps/ai evals`.

## Tests

`apps/ai/tests/test_units.py` (embedders), `apps/ai/tests/test_service.py` (indexing and
retrieval against Postgres), `apps/ai/tests/test_models_match_db.py` after a migration.
