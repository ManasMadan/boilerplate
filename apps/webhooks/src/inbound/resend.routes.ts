/**
 * POST /webhooks/resend: Resend's delivery feedback, so we stop emailing addresses that
 * can't or don't want to receive it. A hard bounce or a spam complaint becomes an
 * `email.feedback_received.v1` event; apps/notifications adds the address to its
 * suppression list, which every email is checked against. Other event types are
 * acknowledged and ignored.
 *
 * Resend signs with Svix, which is the Standard Webhooks scheme under `svix-*` header
 * names, so the same verification as our own deliveries applies (outbound/signing.ts),
 * plus the standard's five-minute window against replays. Like Stripe's route: raw body,
 * each event stored once (webhooks.inbound_event is unique on the provider's id), event
 * and outbox row in one transaction, nothing processed here.
 */
import { type Prisma, transaction } from "@repo/db";
import type { Database } from "@repo/nest-common";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verify } from "../outbound/signing";
import { emitEvent } from "../outbox";

const TOLERANCE_SECONDS = 5 * 60;

/** The parts of Resend's event we act on. */
const resendEvent = z.object({
  type: z.string(),
  data: z
    .object({
      to: z.array(z.string()).default([]),
      /** Present on email.bounced; transient bounces are retried by Resend itself. */
      bounce: z.object({ type: z.string().optional() }).optional(),
    })
    .default({ to: [] }),
});

/** Which feedback an event is, or null for events we don't act on. */
function feedbackOf(event: z.infer<typeof resendEvent>) {
  if (event.type === "email.complained") return "complaint" as const;
  if (event.type !== "email.bounced") return null;
  const bounceType = event.data.bounce?.type?.toLowerCase();
  return bounceType === "transient" || bounceType === "temporary" ? null : ("bounce" as const);
}

export function mountResend(
  fastify: FastifyInstance,
  database: Database,
  secret: string | undefined,
  now = () => Date.now(),
) {
  fastify.register((scope, _options, done) => {
    // Raw bytes for this route only: the signature covers the body exactly as sent.
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body),
    );

    scope.post("/webhooks/resend", async (request, reply) => {
      if (!secret) return reply.status(404).send({ code: "NOT_FOUND" });
      const id = request.headers["svix-id"];
      const timestamp = Number(request.headers["svix-timestamp"]);
      const signature = request.headers["svix-signature"];
      if (
        typeof id !== "string" ||
        typeof signature !== "string" ||
        !Number.isInteger(timestamp) ||
        !Buffer.isBuffer(request.body)
      ) {
        return reply.status(400).send({ code: "BAD_REQUEST" });
      }
      const body = request.body.toString("utf8");
      const fresh = Math.abs(now() / 1000 - timestamp) <= TOLERANCE_SECONDS;
      if (!fresh || !verify(secret, id, timestamp, body, signature)) {
        return reply.status(400).send({ code: "INVALID_SIGNATURE" });
      }

      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        return reply.status(400).send({ code: "BAD_REQUEST" });
      }
      const parsed = resendEvent.safeParse(json);
      if (!parsed.success) return reply.status(400).send({ code: "BAD_REQUEST" });
      const event = parsed.data;
      const kind = feedbackOf(event);
      const addresses = kind
        ? event.data.to.filter((address) => z.email().safeParse(address).success)
        : [];

      await transaction(database.write, async (tx) => {
        const inserted = await tx.webhookInboundEvent.createManyAndReturn({
          data: [
            {
              provider: "resend",
              providerEventId: id,
              type: event.type,
              payload: json as Prisma.InputJsonObject,
            },
          ],
          skipDuplicates: true,
          select: { id: true },
        });
        if (!inserted[0] || !kind) return; // already received, or nothing to act on
        for (const address of addresses) {
          await emitEvent(
            tx,
            "email.feedback_received.v1",
            `${id}:${address}`,
            { provider: "resend", kind, address },
            { actorId: null, orgId: null },
          );
        }
      });
      return reply.status(200).send({ received: true });
    });
    done();
  });
}
