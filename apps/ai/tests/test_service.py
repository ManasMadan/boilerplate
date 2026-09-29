"""The service against real Postgres and Redis (`bun run test:integration`):
routes, tenancy, indexing, retrieval, the assistant's stream, budgets and the worker.

Uses the database in AI_DATABASE_URL (migrated), with fresh organizations per test,
and its own Redis database; fixtures are written as the migrator.
"""

import json
import os
import subprocess
import sys
import time
from collections.abc import Iterator
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID, uuid4

import psycopg
import pytest
import redis
from fastapi.testclient import TestClient

from app.settings import get_settings
from tests.tokens import SECRET, service_token

pytestmark = pytest.mark.integration

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


def _migrator() -> psycopg.Connection:
    return psycopg.connect(os.environ["MIGRATOR_DATABASE_URL"], autocommit=True)


def as_org(org: UUID, query: str, params: tuple[object, ...] = ()) -> list[tuple[object, ...]]:
    """A statement on ai tables, scoped to one organization (row-level security applies
    to every role, the migrator included)."""
    with _migrator() as db, db.transaction():
        db.execute("SELECT set_config('app.org_id', %s, true)", (str(org),))
        cursor = db.execute(query, params)  # pyright: ignore[reportArgumentType]
        return cursor.fetchall() if cursor.description else []


def new_org() -> tuple[UUID, UUID]:
    """An organization with one user, as apps/api would have created them."""
    org, user = uuid4(), uuid4()
    with _migrator() as db:
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


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    redis.Redis.from_url(REDIS_URL).flushdb()
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client
    get_settings.cache_clear()


def index_all(client: TestClient, org: UUID) -> None:
    """What the worker does for each queued document, run in-process."""
    from app.main import app

    documents = app.state.documents
    for doc in client.get("/v1/documents", headers=headers(org, uuid4())).json():
        # On the app's own event loop, where its database engine lives.
        client.portal.call(documents.index, org, UUID(doc["id"]))  # pyright: ignore[reportOptionalMemberAccess]


def test_health(client: TestClient) -> None:
    assert client.get("/health/live").json() == {"status": "ok"}
    assert client.get("/health/ready").json() == {"status": "ok"}


def test_every_route_needs_the_api_s_token(client: TestClient) -> None:
    for method, path in [
        ("get", "/v1/documents"),
        ("post", "/v1/documents"),
        ("post", "/v1/assistant/answers"),
        ("post", "/v1/sentiment"),
    ]:
        response = client.request(method, path, headers={"x-request-id": "r1"})
        assert response.status_code == 401
        assert response.json() == {
            "code": "UNAUTHENTICATED",
            "status": 401,
            "requestId": "r1",
            "params": {},
        }


def test_invalid_input_is_a_validation_error(client: TestClient) -> None:
    org, user = new_org()
    response = client.post("/v1/documents", json={"title": ""}, headers=headers(org, user))
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "VALIDATION_FAILED"
    assert {tuple(issue["path"]) for issue in body["params"]["issues"]} == {
        ("title",),
        ("content",),
    }


def test_adding_a_document_queues_it_and_indexing_makes_it_searchable(client: TestClient) -> None:
    org, user = new_org()
    events = redis.Redis.from_url(REDIS_URL).pubsub()
    events.subscribe(f"realtime:org:{org}")
    created = client.post(
        "/v1/documents",
        json={
            "title": "Handbook",
            "content": "Refunds take five days.\n\nThe office is in Lisbon.",
        },
        headers=headers(org, user),
    )
    assert created.status_code == 201
    document = created.json()
    assert document["status"] == "pending"

    # Queued once, under the shared queue's prefix, with the document id as the job id.
    r = redis.Redis.from_url(REDIS_URL)
    job = r.hgetall(f"{{ai-ingest}}:ai-ingest:{document['id']}")
    assert json.loads(job[b"data"])["payload"] == {"documentId": document["id"], "orgId": str(org)}

    index_all(client, org)
    [listed] = client.get("/v1/documents", headers=headers(org, user)).json()
    assert listed["status"] == "ready"
    assert listed["chunkCount"] == 1

    # Screens showing the documents were told, when it was added and when it was ready.
    messages = [
        m for m in iter(lambda: events.get_message(timeout=1), None) if m["type"] == "message"
    ]
    assert [json.loads(m["data"]) for m in messages] == [{"type": "documents.changed"}] * 2


def test_each_workspace_sees_only_its_documents(client: TestClient) -> None:
    org, user = new_org()
    other_org, other_user = new_org()
    doc = client.post(
        "/v1/documents",
        json={"title": "Private", "content": "Secret plans."},
        headers=headers(org, user),
    ).json()
    assert client.get("/v1/documents", headers=headers(other_org, other_user)).json() == []
    deleted = client.delete(f"/v1/documents/{doc['id']}", headers=headers(other_org, other_user))
    assert deleted.status_code == 404
    assert deleted.json()["code"] == "DOCUMENT_NOT_FOUND"
    assert (
        client.delete(f"/v1/documents/{doc['id']}", headers=headers(org, user)).status_code == 204
    )
    assert client.get("/v1/documents", headers=headers(org, user)).json() == []


def _answer(client: TestClient, org: UUID, user: UUID, question: str) -> list[dict[str, object]]:
    with client.stream(
        "POST", "/v1/assistant/answers", json={"question": question}, headers=headers(org, user)
    ) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        return [
            json.loads(line.removeprefix("data: "))["event"]
            for line in response.iter_lines()
            if line.startswith("data: ")
        ]


def test_the_assistant_streams_an_answer_from_the_workspace_s_documents(client: TestClient) -> None:
    org, user = new_org()
    other_org, other_user = new_org()
    doc = client.post(
        "/v1/documents",
        json={"title": "Handbook", "content": "Refunds take five business days to arrive."},
        headers=headers(org, user),
    ).json()
    client.post(
        "/v1/documents",
        json={"title": "Theirs", "content": "Refunds are instant here."},
        headers=headers(other_org, other_user),
    )
    index_all(client, org)
    index_all(client, other_org)

    events = _answer(client, org, user, "How long do refunds take?")
    text = "".join(str(e["text"]) for e in events if e["type"] == "text").strip()
    assert text == "From “Handbook”: Refunds take five business days to arrive."
    assert {
        "type": "sources",
        "sources": [{"documentId": doc["id"], "title": "Handbook"}],
    } in events
    done = events[-1]
    assert done["type"] == "done"
    usage = done["usage"]
    assert isinstance(usage, dict) and usage["inputTokens"] > 0  # pyright: ignore[reportUnknownMemberType]

    rows = as_org(org, "SELECT feature, model, user_id FROM ai.usage WHERE org_id = %s", (org,))
    assert rows == [("assistant", "local:extractive", user)]


def test_a_workspace_over_its_monthly_budget_is_refused(client: TestClient) -> None:
    org, user = new_org()
    as_org(
        org,
        "INSERT INTO ai.usage (org_id, feature, model, input_tokens, output_tokens)"
        " VALUES (%s, 'assistant', 'x', 2000000, 0)",
        (org,),
    )
    response = client.post(
        "/v1/assistant/answers", json={"question": "Hello?"}, headers=headers(org, user)
    )
    assert response.status_code == 429
    assert response.json()["code"] == "AI_BUDGET_EXCEEDED"


def test_a_workspace_over_its_monthly_budget_gets_no_summary(client: TestClient) -> None:
    from app.main import app

    org, user = new_org()
    doc = client.post(
        "/v1/documents", json={"title": "T", "content": "Some text."}, headers=headers(org, user)
    ).json()
    as_org(
        org,
        "INSERT INTO ai.usage (org_id, feature, model, input_tokens, output_tokens)"
        " VALUES (%s, 'assistant', 'x', 2000000, 0)",
        (org,),
    )
    index_all(client, org)
    client.portal.call(app.state.documents.summarize, org, UUID(doc["id"]), user)  # pyright: ignore[reportOptionalMemberAccess]
    [listed] = client.get("/v1/documents", headers=headers(org, user)).json()
    assert (listed["status"], listed["summary"]) == ("ready", None)
    assert as_org(org, "SELECT count(*) FROM ai.usage WHERE feature = 'summary'") == [(0,)]


def test_the_assistant_is_off_without_a_model(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    org, user = new_org()
    monkeypatch.delenv("AI_MODEL")
    get_settings.cache_clear()
    from app.main import app

    with TestClient(app) as without:
        response = without.post(
            "/v1/assistant/answers", json={"question": "Hi"}, headers=headers(org, user)
        )
    assert response.status_code == 404
    assert response.json() == {
        "code": "FEATURE_DISABLED",
        "status": 404,
        "requestId": "req-test",
        "params": {"feature": "assistant"},
    }


def test_the_worker_indexes_queued_documents_then_summarizes_them(client: TestClient) -> None:
    org, user = new_org()
    doc = client.post(
        "/v1/documents",
        json={
            "title": "Queued",
            "content": "Indexed by the worker. Then summarized.",
        },
        headers=headers(org, user),
    ).json()
    assert doc["summary"] is None
    env = {**os.environ, **ENV}
    worker = subprocess.Popen([sys.executable, "-m", "app.worker"], env=env)
    try:
        deadline = time.monotonic() + 20
        listed: dict[str, object] = {"status": "pending", "summary": None}
        while time.monotonic() < deadline and listed["summary"] is None:
            time.sleep(0.2)
            [listed] = client.get("/v1/documents", headers=headers(org, user)).json()
        assert listed["status"] == "ready", f"document {doc['id']} is {listed['status']}"
        # The local summarizer keeps a passage's opening sentence.
        assert listed["summary"] == "Indexed by the worker."
        [(feature, model, by)] = as_org(
            org, "SELECT feature, model, user_id FROM ai.usage WHERE org_id = %s", (org,)
        )
        assert (feature, model, by) == ("summary", "local:extractive", user)
    finally:
        worker.terminate()
        assert worker.wait(timeout=10) == 0
