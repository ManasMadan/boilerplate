"""Tokens as apps/api signs them, for tests."""

import time
from typing import Any
from uuid import UUID

import jwt

SECRET = "test-ai-service-secret-at-least-32-characters"


def service_token(
    user_id: UUID, org_id: UUID, *, secret: str = SECRET, lifetime: int = 60, **overrides: Any
) -> str:
    now = int(time.time())
    claims: dict[str, Any] = {
        "iss": "api",
        "aud": "ai",
        "sub": str(user_id),
        "org": str(org_id),
        "iat": now,
        "exp": now + lifetime,
        **overrides,
    }
    return jwt.encode({k: v for k, v in claims.items() if v is not None}, secret, algorithm="HS256")
