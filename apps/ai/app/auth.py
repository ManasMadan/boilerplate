"""Only apps/api may call this service, on behalf of a user in an organization.

The API has already authenticated the user and checked their membership; it sends a
JWT (HS256, AI_SERVICE_SECRET) that lives 60 seconds and names both. This service
trusts nothing else: every route except health checks requires the token, and every
query is scoped to the organization it names (row-level security).
"""

from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

import jwt
import structlog
from fastapi import Depends, Header

from app.errors import AppError
from app.settings import Settings, get_settings

AUDIENCE = "ai"
ISSUER = "api"
MAX_LIFETIME_SECONDS = 120


@dataclass(frozen=True)
class Caller:
    user_id: UUID
    org_id: UUID


def verify(token: str, secret: str) -> Caller:
    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            audience=AUDIENCE,
            issuer=ISSUER,
            options={"require": ["exp", "iat", "sub", "org"]},
        )
        if claims["exp"] - claims["iat"] > MAX_LIFETIME_SECONDS:
            raise jwt.InvalidTokenError("token lives too long")
        return Caller(user_id=UUID(claims["sub"]), org_id=UUID(claims["org"]))
    except (jwt.InvalidTokenError, ValueError, KeyError) as error:
        raise AppError("UNAUTHENTICATED", 401) from error


def caller(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[str | None, Header()] = None,
    x_request_id: Annotated[str | None, Header()] = None,
) -> Caller:
    if not authorization or not authorization.startswith("Bearer "):
        raise AppError("UNAUTHENTICATED", 401)
    verified = verify(authorization.removeprefix("Bearer "), settings.service_secret)
    structlog.contextvars.bind_contextvars(
        request_id=x_request_id, org_id=str(verified.org_id), user_id=str(verified.user_id)
    )
    return verified


CallerDep = Annotated[Caller, Depends(caller)]
