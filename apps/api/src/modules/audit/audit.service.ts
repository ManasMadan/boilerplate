import { Inject, Injectable } from "@nestjs/common";
import type { AuditEntry } from "@repo/contracts/api";
import type { EventName } from "@repo/contracts/events";
import { type PageInput, toPage } from "@repo/contracts/pagination";
import { AuditRepository } from "./audit.repository";

@Injectable()
export class AuditService {
  constructor(@Inject(AuditRepository) private readonly audit: AuditRepository) {}

  async list(orgId: string, input: PageInput) {
    const rows = await this.audit.list(orgId, input);
    const actorIds = [...new Set(rows.flatMap((row) => (row.actorId ? [row.actorId] : [])))];
    const actors = new Map((await this.audit.actors(actorIds)).map((user) => [user.id, user]));
    const entries: AuditEntry[] = rows.map((row) => ({
      id: row.id,
      name: row.name as EventName,
      occurredAt: row.occurredAt,
      actor: (row.actorId && actors.get(row.actorId)) || null,
      payload: (row.payload ?? {}) as Record<string, unknown>,
    }));
    return toPage(entries, input.limit);
  }
}
