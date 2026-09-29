---
name: swap-document-search
description: Change how the assistant retrieves passages (a dedicated vector database, hybrid keyword and vector search, a search service). Use when retrieval needs to scale past Postgres or needs ranking pgvector doesn't give.
---

# Swap document search

- **Interface:** `PassageSearch` (`search(org_id, query, limit) -> list[Passage]`) in
  `apps/ai/app/assistant.py`: all the assistant's `search_documents` tool needs.
- **Today:** `Documents.search` in `apps/ai/app/documents.py`: embeds the query and
  runs a cosine nearest-neighbour query over `ai.chunk` (pgvector, HNSW), scoped to the
  organization by row-level security (`tenant(org_id)`). The evals use an in-memory
  library (`apps/ai/evals/library.py`); the MCP server (`apps/ai/app/mcp_server.py`)
  searches through the same `Documents`.
- **Env:** `AI_EMBEDDINGS`, `AI_MIN_RELEVANCE` (see swap-embeddings).

Only the query side is behind the interface. Indexing (chunks and vectors written by
the worker) and deletion live in `Documents` too.

## Swap

1. Implement the new store in `Documents`: write passages and vectors where indexing
   writes `DocumentChunk` today, delete them with the document, and query them in
   `search`. Every query must filter by organization: an external store has no
   row-level security, so the org id goes in every filter.
2. Keep returning `Passage` with a similarity `score`, and keep the relevance floor, so
   the assistant and MCP tool don't change.
3. The store's address and key in `apps/ai/app/settings.py`, `.env.example` and
   `docs/environment.md`.

## Tests

`apps/ai/tests/test_service.py` covers indexing, retrieval and tenancy; add a case that
one organization can't retrieve another's passages from the new store. Compare quality
with `bun run --cwd apps/ai evals`.
