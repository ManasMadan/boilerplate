# The development container: the Node, Bun, uv and OpenTofu versions CI and the images
# use (Renovate keeps them in step). Python itself comes from uv, which installs the
# version in apps/ai/.python-version on the first `uv sync`.
FROM oven/bun:1.3.6@sha256:f20d9cf365ab35529384f1717687c739c92e6f39157a35a95ef06f4049a10e4a AS bun
FROM ghcr.io/astral-sh/uv:0.12.17@sha256:10787c682e4184e4f290de1171fd4703dc63de99221f10fe1c99002ce7fa9acc AS uv
FROM ghcr.io/opentofu/opentofu:1.11.6-minimal@sha256:3e11ca509319257e46ea6fb1b98cf77d185a1e370cc8dd1bf187f6b8515a73d9 AS tofu

FROM mcr.microsoft.com/devcontainers/javascript-node:5.2.1-24-trixie@sha256:7a81958053c4e3b5b20fa122f7a422d32dd0eebe87a6726f7b14483585ea60fd
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=tofu /usr/local/bin/tofu /usr/local/bin/tofu
# The base image's own non-root user, which VS Code and Codespaces connect as anyway.
USER node
