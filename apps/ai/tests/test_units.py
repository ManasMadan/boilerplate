"""Pure tests: no database, Redis or model provider."""

import math
import os
import secrets
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from app.assistant import Deps, create_agent, local_extractive
from app.auth import verify
from app.documents import Passage, create_summaries
from app.embeddings import HashingEmbedder
from app.errors import AppError
from app.settings import Settings
from tests.tokens import SECRET, service_token

USER, ORG = uuid4(), uuid4()


def test_a_valid_token_names_the_user_and_organization() -> None:
    caller = verify(service_token(USER, ORG), SECRET)
    assert (caller.user_id, caller.org_id) == (USER, ORG)


@pytest.mark.parametrize(
    "token",
    [
        service_token(USER, ORG, secret=secrets.token_urlsafe(32)),  # someone else's
        service_token(USER, ORG, lifetime=-10),  # expired
        service_token(USER, ORG, aud="web"),
        service_token(USER, ORG, iss="someone"),
        service_token(USER, ORG, org=None),
        service_token(USER, ORG, lifetime=3_600),  # lives too long to be one call's
        service_token(USER, ORG, org="not-a-uuid"),
        "not.a.jwt",
    ],
)
def test_bad_tokens_are_refused(token: str) -> None:
    with pytest.raises(AppError) as error:
        verify(token, SECRET)
    assert (error.value.code, error.value.status) == ("UNAUTHENTICATED", 401)


def _settings(**env: str) -> Settings:
    """Settings from exactly these values: the process environment (a loaded .env when
    tests run alongside the integration suite) must not leak in."""
    base = {
        "AI_DATABASE_URL": "postgresql://u:p@localhost/db",
        "REDIS_URL": "redis://localhost:6379",
        "AI_SERVICE_SECRET": SECRET,
    }
    with patch.dict(os.environ, {}, clear=True):
        return Settings.model_validate({**base, **env})


def test_production_refuses_development_stand_ins() -> None:
    assert _settings(NODE_ENV="production", AI_EMBEDDINGS="openai:text-embedding-3-small")
    with pytest.raises(ValidationError, match="AI_EMBEDDINGS=hashing"):
        _settings(NODE_ENV="production")
    with pytest.raises(ValidationError, match="local:extractive"):
        _settings(
            NODE_ENV="production",
            AI_EMBEDDINGS="openai:text-embedding-3-small",
            AI_MODEL="local:extractive",
        )
    with pytest.raises(ValidationError):
        _settings(AI_SERVICE_SECRET="x" * 31)  # one character short


async def test_hashing_embeddings_put_similar_wording_close() -> None:
    [query, near, far] = await HashingEmbedder().embed(
        [
            "refund policy for annual plans",
            "our refund policy: annual plans are refundable",
            "the office dog is called Max",
        ]
    )

    def cosine(a: list[float], b: list[float]) -> float:
        return sum(x * y for x, y in zip(a, b, strict=True))

    assert len(query) == 1536
    assert math.isclose(cosine(query, query), 1.0, abs_tol=1e-9)
    assert cosine(query, near) > cosine(query, far)


class StubDocuments:
    def __init__(self, passages: list[Passage]) -> None:
        self.passages = passages
        self.queries: list[str] = []

    async def search(self, org_id: UUID, query: str, limit: int = 5) -> list[Passage]:
        self.queries.append(query)
        return self.passages


async def test_the_agent_searches_then_answers_from_the_passage() -> None:
    doc = uuid4()
    documents = StubDocuments(
        [Passage(document_id=doc, title="Handbook", content="Refunds take 5 days.", score=0.9)]
    )
    deps = Deps(org_id=ORG, documents=documents)
    result = await create_agent(local_extractive()).run("How long do refunds take?", deps=deps)
    assert documents.queries == ["How long do refunds take?"]
    assert result.output == "From “Handbook”: Refunds take 5 days."
    assert deps.sources == {doc: "Handbook"}


async def test_the_agent_says_so_when_nothing_matches() -> None:
    deps = Deps(org_id=ORG, documents=StubDocuments([]))
    result = await create_agent(local_extractive()).run("Anything?", deps=deps)
    assert result.output == "I couldn't find that in the workspace's documents."
    assert deps.sources == {}


def test_the_sentiment_model() -> None:
    from app.model import predict

    assert predict("I love this, it is great")[0] == "positive"
    assert predict("this is terrible")[0] == "negative"
    assert predict("the sky is blue") == ("neutral", 0.5)


def test_summaries_follow_the_configured_model() -> None:
    assert create_summaries(_settings()) is None
    summaries = create_summaries(_settings(AI_MODEL="local:extractive", AI_TOKENS_PER_RUN="5000"))
    assert summaries is not None
    assert (summaries.model_name, summaries.monthly_tokens) == ("local:extractive", 2_000_000)
