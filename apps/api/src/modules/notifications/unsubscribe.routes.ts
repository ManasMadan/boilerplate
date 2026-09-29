/**
 * POST /api/v1/notifications/unsubscribe?token=…: RFC 8058 one-click unsubscribe. Mail
 * clients (Gmail, Apple Mail) POST `List-Unsubscribe=One-Click` to the URL in the email's
 * List-Unsubscribe header, with no session and no page, and expect a 2xx. The signed
 * token in the URL says who and which category. People clicking the link in the email
 * body land on the web app's /unsubscribe page instead.
 */
import type { FastifyInstance } from "fastify";
import type { NotificationsService } from "./notifications.service";

export function mountOneClickUnsubscribe(
  fastify: FastifyInstance,
  notifications: NotificationsService,
) {
  fastify.register((scope, _options, done) => {
    // The body is a form field we don't need; accept it without parsing (replacing the
    // app's form parser in this scope only).
    scope.removeContentTypeParser("application/x-www-form-urlencoded");
    scope.addContentTypeParser("application/x-www-form-urlencoded", (_request, _payload, next) =>
      next(null, undefined),
    );
    scope.post<{ Querystring: { token?: string } }>(
      "/api/v1/notifications/unsubscribe",
      async (request, reply) => {
        const token = request.query.token;
        if (!token) return reply.status(400).send({ code: "UNSUBSCRIBE_LINK_INVALID" });
        try {
          await notifications.unsubscribe(token);
          return reply.status(200).send({ unsubscribed: true });
        } catch {
          return reply.status(400).send({ code: "UNSUBSCRIBE_LINK_INVALID" });
        }
      },
    );
    done();
  });
}
