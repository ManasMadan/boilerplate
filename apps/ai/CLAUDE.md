# apps/ai

Python 3.14 service: FastAPI (port 8000), Pydantic AI agents, a LangGraph summarizer,
pgvector retrieval, a BullMQ worker (`app/worker.py`, queue `ai-ingest`) and an MCP
server for documents. Internal only: callers sign a short-lived JWT with
`AI_SERVICE_SECRET`; the TypeScript client is `packages/ai-client`.

## Commands (from the repo root)

- Lint and format check: `uv run --project apps/ai ruff check apps/ai` and
  `uv run --project apps/ai ruff format --check apps/ai` (or `bun run lint`)
- Types: `bun run --filter @repo/ai check-types` (basedpyright, strict)
- Unit tests: `bun run --filter @repo/ai test`
- Integration tests (Postgres and Redis): `bun run db:up`, then
  `bun run --filter @repo/ai test:integration`
- Evals with the local stand-ins: `bun run --cwd apps/ai evals`
- After changing routes, models or `packages/jobs`: `bun run gen`

## Where things are

- `app/main.py`: routes. `app/schemas.py`: request and response models (the contract).
- `app/settings.py`: every setting, loaded once with `get_settings()`.
- `app/db/session.py`: `tenant(org_id)` sessions (sets `app.org_id` for RLS).
- `app/contracts/`: generated from `packages/jobs`; never edit.
- `evals/`: pydantic-evals datasets over a fixed handbook.

## Gotchas

- Without a model provider, `AI_MODEL=local:extractive` and `AI_EMBEDDINGS=hashing`
  give deterministic answers; tests and e2e rely on them. Production refuses both.
- The database schema is owned by Prisma migrations. Change it there, then update
  `app/db/models.py`; `tests/test_models_match_db.py` fails on drift.
- The service connects as `app_ai` and cannot see rows without `app.org_id` set.
- Token budgets per org and per run are enforced in `app/usage.py`; new model calls go
  through the same accounting.
