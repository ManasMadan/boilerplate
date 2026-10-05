/**
 * Serves the app's web build (`bun run build:web` → dist/) with the API on the same
 * origin, the way the gateway serves apps/web: /rpc and /api go to the API, anything
 * else is the single-page app. Used by the end-to-end tests, and to try the app in a
 * browser: `bun run serve:web`.
 *
 *   MOBILE_WEB_PORT  where to listen
 *   API_URL          where apps/api is
 *
 * both from the root .env (or the e2e run, which sets them for this checkout's stack).
 *
 * That origin must be one of the API's APP_ORIGINS, or sign-in is refused (CSRF check).
 */
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} isn't set: run \`bun run setup --env\` to add it to .env.`);
    process.exit(1);
  }
  return value;
};
const port = Number(required("MOBILE_WEB_PORT"));
const api = required("API_URL");
const dist = join(import.meta.dirname, "..", "dist");
const index = join(dist, "index.html");
if (!existsSync(index)) {
  console.error("No web build: run `bun run build:web` first.");
  process.exit(1);
}

/** Response headers that describe the upstream encoding, which fetch has already undone. */
const HOP_BY_HOP = ["content-encoding", "content-length", "transfer-encoding", "connection"];

async function proxy(request: Request, url: URL) {
  const upstream = await fetch(new URL(url.pathname + url.search, api), {
    method: request.method,
    headers: request.headers,
    body:
      request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer(),
    redirect: "manual",
  });
  const headers = new Headers(upstream.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  return new Response(upstream.body, { status: upstream.status, headers });
}

function asset(pathname: string) {
  const file = normalize(join(dist, pathname));
  // Never outside dist/, and directories fall through to the app.
  if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
    return new Response(Bun.file(file));
  }
  return new Response(Bun.file(index), { headers: { "content-type": "text/html" } });
}

Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (/^\/(rpc|api)(\/|$)/.test(url.pathname)) return proxy(request, url);
    return asset(url.pathname);
  },
});
console.log(`Mobile web build on http://localhost:${port} (API ${api})`);
