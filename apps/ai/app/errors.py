"""Errors in the same shape as every other service: `{code, status, requestId, params}`.

Codes are the stable ones from packages/contracts errors.ts; apps/api passes them on to
clients, which translate them. Raise `AppError("CODE", status, params)`; anything else
becomes INTERNAL (details logged, never returned).
"""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from app.log import log


class AppError(Exception):
    def __init__(self, code: str, status: int, params: dict[str, Any] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.status = status
        self.params = params or {}


def _body(request: Request, code: str, status: int, params: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": code,
        "status": status,
        "requestId": request.headers.get("x-request-id"),
        "params": params,
    }


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error(request: Request, error: AppError) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        return JSONResponse(
            _body(request, error.code, error.status, error.params), status_code=error.status
        )

    @app.exception_handler(RequestValidationError)
    async def validation(request: Request, error: RequestValidationError) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        issues = [
            {"path": [str(part) for part in e["loc"][1:]], "code": e["type"]}
            for e in error.errors()
        ]
        return JSONResponse(
            _body(request, "VALIDATION_FAILED", 422, {"issues": issues}), status_code=422
        )

    @app.exception_handler(HTTPException)
    async def http(request: Request, error: HTTPException) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        code = {401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND"}.get(
            error.status_code, "BAD_REQUEST"
        )
        return JSONResponse(
            _body(request, code, error.status_code, {}), status_code=error.status_code
        )

    @app.exception_handler(Exception)
    async def unexpected(request: Request, error: Exception) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        log.exception("unhandled error", path=request.url.path, error=str(error))
        return JSONResponse(_body(request, "INTERNAL", 500, {}), status_code=500)
