/** The organization's audit log (owners and admins only). */
import { z } from "zod";
import { eventNames } from "../events";
import { page, pageInput } from "../pagination";
import { base } from "./base";

export const auditEntrySchema = z.object({
  id: z.uuid(),
  /** Versioned event name; the client translates it for display. */
  name: z.enum(eventNames),
  occurredAt: z.date(),
  /** Who did it; null for system actions or deleted accounts. */
  actor: z.object({ id: z.uuid(), name: z.string(), email: z.email() }).nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditContract = {
  list: base
    .route({
      method: "GET",
      path: "/audit",
      tags: ["Audit"],
      summary: "The active organization's audit log, newest first",
    })
    .input(pageInput)
    .output(page(auditEntrySchema)),
};
