"""What the integration tests share: settings for the service under test, fixtures
written straight to the database (as the migrator), and service tokens."""

import os
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID, uuid4

import psycopg
from fastapi.testclient import TestClient

from tests.tokens import SECRET, service_token

# Its own Redis database (the TypeScript suites use 7-15; 0 is the dev stack).
REDIS_URL = urlunsplit(
    urlsplit(os.environ.get("REDIS_URL", "redis://localhost:6379"))._replace(path="/6")
)
ENV = {
    "REDIS_URL": REDIS_URL,
    "AI_SERVICE_SECRET": SECRET,
    "AI_MODEL": "local:extractive",
    "AI_EMBEDDINGS": "hashing",
    "AI_MONTHLY_TOKENS_PER_ORG": "2000000",
    "NODE_ENV": "test",
}


def migrator() -> psycopg.Connection:
    return psycopg.connect(os.environ["MIGRATOR_DATABASE_URL"], autocommit=True)


def as_org(org: UUID, query: str, params: tuple[object, ...] = ()) -> list[tuple[object, ...]]:
    """A statement on ai tables, scoped to one organization (row-level security applies
    to every role, the migrator included)."""
    with migrator() as db, db.transaction():
        db.execute("SELECT set_config('app.org_id', %s, true)", (str(org),))
        cursor = db.execute(query, params)  # pyright: ignore[reportArgumentType]
        return cursor.fetchall() if cursor.description else []


def new_org() -> tuple[UUID, UUID]:
    """An organization with one user, as apps/api would have created them."""
    org, user = uuid4(), uuid4()
    with migrator() as db:
        db.execute(
            "INSERT INTO auth.organization (id, name, slug) VALUES (%s, 'Org', %s)", (org, str(org))
        )
        db.execute(
            'INSERT INTO auth."user" (id, name, email, updated_at) VALUES (%s, %s, %s, now())',
            (user, "U", f"{user}@test.dev"),
        )
    return org, user


def headers(org: UUID, user: UUID) -> dict[str, str]:
    return {"authorization": f"Bearer {service_token(user, org)}", "x-request-id": "req-test"}


def index_all(client: TestClient, org: UUID) -> None:
    """What the worker does for each queued document, run in-process."""
    from app.main import app

    documents = app.state.documents
    for doc in client.get("/v1/documents", headers=headers(org, uuid4())).json():
        # On the app's own event loop, where its database engine lives.
        client.portal.call(documents.index, org, UUID(doc["id"]))  # pyright: ignore[reportOptionalMemberAccess]
