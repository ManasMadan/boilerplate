"""The MCP server (app/mcp_server.py): token checks on their own, then the mounted server
over HTTP with tokens signed like apps/api signs them and grants in the real database.
The api's side (issuing those tokens) is covered in apps/api/test/oauth.integration.test.ts.
"""

import json
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from uuid import UUID, uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from app.mcp_server import ApiKeys, ApiTokenVerifier
from tests.support import headers, index_all, migrator, new_org

SITE = "https://site.test"
ISSUER = f"{SITE}/api/auth"
RESOURCE = f"{SITE}/ai/mcp"


class SigningKey:
    def __init__(self, kid: str) -> None:
        self.kid = kid
        self.private = Ed25519PrivateKey.generate()
        jwk = json.loads(jwt.algorithms.OKPAlgorithm.to_jwk(self.private.public_key()))  # pyright: ignore[reportUnknownMemberType, reportUnknownArgumentType]
        self.jwk: dict[str, Any] = {**jwk, "kid": kid, "alg": "EdDSA", "use": "sig"}

    def sign(self, **claims: Any) -> str:
        now = int(time.time())
        payload = {
            "iss": ISSUER,
            "aud": RESOURCE,
            "sub": str(uuid4()),
            "org": str(uuid4()),
            "azp": "client-1",
            "scope": "documents:read",
            "iat": now,
            "exp": now + 900,
            **claims,
        }
        return jwt.encode(
            {k: v for k, v in payload.items() if v is not None},
            self.private,
            algorithm="EdDSA",
            headers={"kid": self.kid},
        )


def verifier(
    keys: list[SigningKey], grant: bool = True
) -> tuple[ApiTokenVerifier, list[int], list[tuple[str, UUID, UUID]]]:
    fetches: list[int] = []
    grants: list[tuple[str, UUID, UUID]] = []

    async def fetch(_url: str) -> dict[str, Any]:
        fetches.append(1)
        return {"keys": [key.jwk for key in keys]}

    async def grant_active(client_id: str, user_id: UUID, org_id: UUID) -> bool:
        grants.append((client_id, user_id, org_id))
        return grant

    return (
        ApiTokenVerifier(ApiKeys("unused", fetch), ISSUER, RESOURCE, grant_active),
        fetches,
        grants,
    )


# ------------------------------------------------------------------------ token checks


async def test_a_valid_token_names_the_caller_and_workspace() -> None:
    key = SigningKey("k1")
    check, _, grants = verifier([key])
    user, org = uuid4(), uuid4()
    token = await check.verify_token(key.sign(sub=str(user), org=str(org)))
    assert token is not None
    assert (token.subject, token.claims, token.client_id) == (
        str(user),
        {"org": str(org)},
        "client-1",
    )
    assert token.scopes == ["documents:read"]
    assert token.resource == RESOURCE
    assert grants == [("client-1", user, org)]


@pytest.mark.parametrize(
    "claims",
    [
        {"exp": int(time.time()) - 60},
        {"iss": "https://elsewhere.test/api/auth"},
        {"aud": f"{SITE}/api/mcp"},
        {"org": None},
        {"org": "not-a-uuid"},
        {"azp": None},
        {"sub": None},
    ],
    ids=[
        "expired",
        "other issuer",
        "other resource",
        "no workspace",
        "bad workspace",
        "no client",
        "no user",
    ],
)
async def test_bad_tokens_are_refused(claims: dict[str, Any]) -> None:
    key = SigningKey("k1")
    check, _, _ = verifier([key])
    assert await check.verify_token(key.sign(**claims)) is None


async def test_a_token_signed_with_another_key_is_refused() -> None:
    ours, theirs = SigningKey("k1"), SigningKey("k1")
    check, _, _ = verifier([ours])
    assert await check.verify_token(theirs.sign()) is None
    assert await check.verify_token("not.a.token") is None


async def test_a_grant_that_no_longer_stands_is_refused() -> None:
    key = SigningKey("k1")
    check, _, _ = verifier([key], grant=False)
    assert await check.verify_token(key.sign()) is None


async def test_keys_are_fetched_once_and_again_only_for_an_unknown_key_id() -> None:
    first = SigningKey("k1")
    keys = [first]
    check, fetches, _ = verifier(keys)
    assert await check.verify_token(first.sign()) is not None
    assert await check.verify_token(first.sign()) is not None
    assert len(fetches) == 1
    # A new key right after the last fetch waits for the refresh interval: forged key
    # ids can't make this service hammer the api.
    second = SigningKey("k2")
    keys.append(second)
    assert await check.verify_token(second.sign()) is None
    assert len(fetches) == 1
    check._keys._fetched_at -= 60  # pyright: ignore[reportPrivateUsage]
    assert await check.verify_token(second.sign()) is not None
    assert len(fetches) == 2


# ------------------------------------------------------------------ the mounted server

KEY = SigningKey("integration")


class _Jwks(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        body = json.dumps({"keys": [KEY.jwk]}).encode()
        self.send_response(200 if self.path == "/api/auth/jwks" else 404)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        pass


@pytest.fixture(scope="module")
def api_url() -> Iterator[str]:
    """Stands in for apps/api's JWKS endpoint."""
    server = HTTPServer(("127.0.0.1", 0), _Jwks)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


@pytest.fixture
def extra_env(api_url: str) -> dict[str, str]:
    """Turns the MCP server on (see app/settings.py), with the stub as the api."""
    return {"BETTER_AUTH_URL": SITE, "API_URL": api_url}


def granted(org: UUID, user: UUID, client_id: str = "client-1") -> None:
    """What approving an app on the consent page leaves in the database."""
    with migrator() as db:
        db.execute(
            "INSERT INTO auth.member (organization_id, user_id, role) VALUES (%s, %s, 'member')",
            (org, user),
        )
        db.execute(
            "INSERT INTO auth.oauth_client (client_id) VALUES (%s) ON CONFLICT DO NOTHING",
            (client_id,),
        )
        db.execute(
            "INSERT INTO auth.oauth_consent (client_id, user_id, reference_id, scopes, updated_at)"
            " VALUES (%s, %s, %s, ARRAY['documents:read'], now())",
            (client_id, user, org),
        )


def rpc(client: TestClient, token: str | None, method: str, params: dict[str, Any]) -> Any:
    response = client.post(
        "/ai/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        headers={
            "accept": "application/json, text/event-stream",
            **({"authorization": f"Bearer {token}"} if token else {}),
        },
    )
    return response


def call(client: TestClient, token: str, tool: str, arguments: dict[str, Any]) -> Any:
    response = rpc(client, token, "tools/call", {"name": tool, "arguments": arguments})
    assert response.status_code == 200, response.text
    return response.json()["result"]


def token_for(org: UUID, user: UUID, **claims: Any) -> str:
    return KEY.sign(sub=str(user), org=str(org), **claims)


@pytest.mark.integration
def test_without_a_token_the_challenge_points_at_the_metadata(client: TestClient) -> None:
    response = rpc(client, None, "tools/list", {})
    assert response.status_code == 401
    assert (
        f'resource_metadata="{SITE}/.well-known/oauth-protected-resource/ai/mcp"'
        in response.headers["www-authenticate"]
    )
    metadata = client.get("/.well-known/oauth-protected-resource/ai/mcp").json()
    assert metadata["resource"] == RESOURCE
    assert metadata["authorization_servers"] == [ISSUER]
    assert metadata["scopes_supported"] == ["documents:read"]


@pytest.mark.integration
def test_other_routes_stay_the_service_s_own(client: TestClient) -> None:
    response = client.get("/ai/nope")
    assert response.status_code == 404
    assert response.json()["code"] == "NOT_FOUND"


@pytest.mark.integration
def test_the_workspace_s_documents_can_be_listed_and_searched(client: TestClient) -> None:
    org, user = new_org()
    granted(org, user)
    client.post(
        "/v1/documents",
        json={"title": "Refunds", "content": "Refunds take five business days."},
        headers=headers(org, user),
    )
    index_all(client, org)
    token = token_for(org, user)

    tools = rpc(client, token, "tools/list", {}).json()["result"]["tools"]
    assert sorted(tool["name"] for tool in tools) == ["list_documents", "search_documents"]

    [listed] = call(client, token, "list_documents", {})["structuredContent"]["result"]
    assert (listed["title"], listed["status"]) == ("Refunds", "ready")
    [best, *_] = call(client, token, "search_documents", {"query": "how long do refunds take"})[
        "structuredContent"
    ]["result"]
    assert best["title"] == "Refunds"
    assert "five business days" in best["content"]


@pytest.mark.integration
def test_only_the_approved_workspace_is_visible(client: TestClient) -> None:
    theirs, owner = new_org()
    client.post(
        "/v1/documents",
        json={"title": "Private", "content": "Only for the other workspace."},
        headers=headers(theirs, owner),
    )
    index_all(client, theirs)
    org, user = new_org()
    granted(org, user)
    token = token_for(org, user)
    assert call(client, token, "list_documents", {})["structuredContent"]["result"] == []
    assert (
        call(client, token, "search_documents", {"query": "other workspace"})["structuredContent"][
            "result"
        ]
        == []
    )


@pytest.mark.integration
def test_a_token_without_the_documents_scope_is_refused(client: TestClient) -> None:
    org, user = new_org()
    granted(org, user)
    response = rpc(client, token_for(org, user, scope="todos:read"), "tools/list", {})
    assert response.status_code == 403
    assert 'error="insufficient_scope"' in response.headers["www-authenticate"]


@pytest.mark.integration
def test_access_ends_when_the_app_is_disconnected_or_the_user_leaves(client: TestClient) -> None:
    org, user = new_org()
    granted(org, user)
    token = token_for(org, user)
    assert rpc(client, token, "tools/list", {}).status_code == 200
    with migrator() as db:
        db.execute("DELETE FROM auth.oauth_consent WHERE user_id = %s", (user,))
    assert rpc(client, token, "tools/list", {}).status_code == 401

    org, user = new_org()
    granted(org, user)
    token = token_for(org, user)
    with migrator() as db:
        db.execute("DELETE FROM auth.member WHERE user_id = %s", (user,))
    assert rpc(client, token, "tools/list", {}).status_code == 401


@pytest.mark.integration
def test_a_token_for_the_other_mcp_server_is_refused(client: TestClient) -> None:
    org, user = new_org()
    granted(org, user)
    response = rpc(client, token_for(org, user, aud=f"{SITE}/api/mcp"), "tools/list", {})
    assert response.status_code == 401


@pytest.mark.integration
def test_tool_input_is_validated(client: TestClient) -> None:
    org, user = new_org()
    granted(org, user)
    result = call(client, token_for(org, user), "search_documents", {"query": ""})
    assert result["isError"] is True


@pytest.mark.integration
def test_calls_are_limited_per_app_and_user(client: TestClient) -> None:
    org, user = new_org()
    granted(org, user)
    token = token_for(org, user)
    results = [call(client, token, "list_documents", {}) for _ in range(61)]
    assert not any(result.get("isError") for result in results[:60])
    assert results[60]["isError"] is True
    assert "RATE_LIMITED" in results[60]["content"][0]["text"]
