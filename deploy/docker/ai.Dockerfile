# syntax=docker/dockerfile:1
#
# The Python AI service. One image, two processes: the HTTP service (default command)
# and the queue worker (`python -m app.worker`, set by the Helm chart).
#
#   docker buildx bake ai             (docker-bake.hcl at the repo root)
#
# Dependencies come from uv.lock exactly (no dev group), into a virtualenv that the
# runtime image copies as is. Python matches the lockfile's, so compiled wheels load.

ARG PYTHON_IMAGE=python:3.14-slim-trixie
ARG UV_VERSION=0.12.17

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM ${PYTHON_IMAGE} AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY apps/ai/pyproject.toml apps/ai/uv.lock ./
RUN --mount=type=cache,id=uv,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY apps/ai/app ./app

FROM ${PYTHON_IMAGE}
ARG RELEASE=dev
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    RELEASE=${RELEASE}
# The code stays owned by root and read-only to the process.
COPY --from=build /app /app
WORKDIR /app
USER 10001:10001
EXPOSE 8000
CMD ["fastapi", "run", "app/main.py", "--host", "0.0.0.0", "--port", "8000"]
