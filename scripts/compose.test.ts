/**
 * The local services have well-known passwords (or none) and Mailpit shows every
 * sign-in code, so every port docker compose publishes listens on localhost unless the
 * developer opens it on purpose (DOCKER_BIND_ADDRESS).
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const compose = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "../docker-compose.yml"), "utf8"),
) as {
  services: Record<string, { ports?: string[] }>;
};

describe("docker-compose.yml", () => {
  const published = Object.entries(compose.services).flatMap(([name, service]) =>
    (service.ports ?? []).map((port) => ({ name, port })),
  );

  it("publishes ports", () => {
    expect(published.length).toBeGreaterThan(0);
  });

  it.each(published)("$name publishes $port on localhost by default", ({ port }) => {
    expect(port).toMatch(/^\$\{DOCKER_BIND_ADDRESS:-127\.0\.0\.1\}:/);
  });
});
