/**
 * GET /api/v1/files/:id/content: redirects to a short-lived storage URL for a ready file
 * the signed-in viewer may read. Pages link to this path (e.g. an avatar's `src`), so the
 * links never expire; each request gets a fresh signed URL.
 */

import { sendError } from "@repo/nest-common";
import type { FastifyInstance } from "fastify";
import type { Auth } from "../../auth/auth";
import { toHeaders } from "../../http-context";
import type { FilesService } from "./files.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function mountFileContent(fastify: FastifyInstance, auth: Auth, files: FilesService) {
  fastify.get<{ Params: { id: string } }>("/api/v1/files/:id/content", async (request, reply) => {
    const session = await auth.api.getSession({ headers: toHeaders(request) });
    if (!session) return sendError(reply, "UNAUTHENTICATED");
    if (!UUID.test(request.params.id)) return sendError(reply, "FILE_NOT_FOUND");
    const download = await files.downloadUrl(session.user.id, request.params.id);
    if (!download) return sendError(reply, "FILE_NOT_FOUND");
    // Cached for less than the signed URL lives, and only by this browser.
    return reply.header("cache-control", "private, max-age=240").redirect(download.url, 302);
  });
}
