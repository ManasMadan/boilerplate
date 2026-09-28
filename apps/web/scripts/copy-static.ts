/**
 * `output: "standalone"` builds a self-contained server but leaves the static assets
 * (and public/) for the host to serve. Copying them next to the server makes
 * `bun run start` and the Docker image serve them the same way, from the same place.
 */
import { cpSync, existsSync } from "node:fs";

const target = ".next/standalone/apps/web";
cpSync(".next/static", `${target}/.next/static`, { recursive: true });
if (existsSync("public")) cpSync("public", `${target}/public`, { recursive: true });
