/**
 * POST /webhooks/stalwart: delivery feedback from our Stalwart mail server, so we stop
 * emailing addresses that can't receive it. Stalwart's WebHook object posts the events
 * it's subscribed to (`delivery.dsn-perm-fail`, `delivery.dsn-temp-fail`) in batches:
 *
 *   X-Signature: base64(HMAC-SHA256(signatureKey, body))
 *   {"events": [{"id", "createdAt", "type", "data": {"to", "details", "queueId", ...}}]}
 *
 * A permanent failure that says the address itself is gone (`isHardBounce` in
 * stalwart-events.ts) becomes an `email.feedback_received.v1` event; apps/notifications
 * adds the address to its suppression list, which every email is checked against.
 * Temporary failures and other events are recorded and not acted on: Stalwart keeps
 * retrying those itself.
 *
 * The signature covers only the body, with no timestamp header, so replays are refused
 * by the events' own signed `createdAt`: Stalwart drops what it couldn't deliver within
 * its `discardAfter` (five minutes by default), so anything much older is a replay.
 *
 * Each event is stored once (webhooks.inbound_event is unique on `eventKey`), so a batch
 * Stalwart retries is harmless. Like Stripe's route: raw body, events and outbox rows in
 * one transaction, nothing processed here.
 */
import { type Prisma, transaction } from "@repo/db";
import type { Database } from "@repo/nest-common";
import type { FastifyInstance } from "fastify";
import { emitEvent } from "../outbox";
import {
  bouncedAddress,
  eventKey,
  isFresh,
  stalwartBatch,
  verifySignature,
} from "./stalwart-events";

export function mountStalwart(
  fastify: FastifyInstance,
  database: Database,
  secrets: readonly string[] | undefined,
  now = () => Date.now(),
) {
  fastify.register((scope, _options, done) => {
    // Raw bytes for this route only: the signature covers the body exactly as sent.
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body),
    );

    scope.post("/webhooks/stalwart", async (request, reply) => {
      if (!secrets) return reply.status(404).send({ code: "NOT_FOUND" });
      const signature = request.headers["x-signature"];
      if (typeof signature !== "string" || !Buffer.isBuffer(request.body)) {
        return reply.status(400).send({ code: "BAD_REQUEST" });
      }
      const body = request.body.toString("utf8");
      if (!verifySignature(secrets, body, signature)) {
        return reply.status(400).send({ code: "INVALID_SIGNATURE" });
      }

      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        return reply.status(400).send({ code: "BAD_REQUEST" });
      }
      const parsed = stalwartBatch.safeParse(json);
      if (!parsed.success) return reply.status(400).send({ code: "BAD_REQUEST" });
      const { events } = parsed.data;
      if (!isFresh(events, now())) return reply.status(400).send({ code: "INVALID_SIGNATURE" });

      const keyed = events.map((event) => ({ event, key: eventKey(event) }));
      await transaction(database.write, async (tx) => {
        const inserted = await tx.webhookInboundEvent.createManyAndReturn({
          data: keyed.map(({ event, key }) => ({
            provider: "stalwart",
            providerEventId: key,
            type: event.type,
            payload: event as Prisma.InputJsonObject,
          })),
          skipDuplicates: true,
          select: { providerEventId: true },
        });
        const fresh = new Set(inserted.map((row) => row.providerEventId));
        for (const { event, key } of keyed) {
          const address = bouncedAddress(event);
          // Nothing to act on, or already received (in an earlier request or twice in
          // this batch: deleting the key makes the first copy the only one acted on).
          if (!address || !fresh.delete(key)) continue;
          await emitEvent(
            tx,
            "email.feedback_received.v1",
            key,
            { provider: "stalwart", kind: "bounce", address },
            { actorId: null, orgId: null },
          );
        }
      });
      return reply.status(200).send({ received: true });
    });
    done();
  });
}
