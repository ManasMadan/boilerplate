# The development container: the Node, Bun, uv and OpenTofu versions CI and the images
# use (Renovate keeps them in step). Python itself comes from uv, which installs the
# version in apps/ai/.python-version on the first `uv sync`.
FROM oven/bun:1.3.6 AS bun
FROM ghcr.io/astral-sh/uv:0.12.17 AS uv
FROM ghcr.io/opentofu/opentofu:1.11.6-minimal AS tofu

FROM mcr.microsoft.com/devcontainers/javascript-node:24-trixie
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=tofu /usr/local/bin/tofu /usr/local/bin/tofu
# The base image's own non-root user, which VS Code and Codespaces connect as anyway.
USER node
