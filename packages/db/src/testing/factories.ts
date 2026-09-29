/**
 * Typed builders for test data, written straight to the database as a service role
 * (app_api), so tenancy and grants apply exactly as in production:
 *
 *   const make = factories(db);
 *   const { user, org } = await make.userWithWorkspace();
 *   await make.todo(org.id, user.id, { completed: true });
 *
 * They skip the application's side effects (emails, audit events, the outbox): use them
 * to arrange state quickly, and drive the API when the side effects are what's tested.
 * Every value has a unique default, so tests never collide; pass overrides for the rest.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../client";
import { tenantTx } from "../tenancy";

const unique = () => randomUUID().slice(0, 8);

export function factories(db: Db) {
  async function user(overrides: { name?: string; email?: string; locale?: string } = {}) {
    const tag = unique();
    return db.user.create({
      data: {
        name: overrides.name ?? `User ${tag}`,
        email: overrides.email ?? `user-${tag}@test.dev`,
        emailVerified: true,
        locale: overrides.locale ?? "en",
      },
    });
  }

  /** An organization owned by `ownerId`; `personal` marks it as that user's own workspace. */
  async function organization(
    ownerId: string,
    overrides: { name?: string; personal?: boolean } = {},
  ) {
    const tag = unique();
    return db.organization.create({
      data: {
        name: overrides.name ?? `Org ${tag}`,
        slug: overrides.personal ? `personal-${ownerId}` : `org-${tag}`,
        ...(overrides.personal && { metadata: JSON.stringify({ personal: true }) }),
        members: { create: { userId: ownerId, role: "owner" } },
      },
    });
  }

  function member(orgId: string, userId: string, role: "owner" | "admin" | "member" = "member") {
    return db.member.create({ data: { organizationId: orgId, userId, role } });
  }

  /** A user with their personal workspace, as sign-up leaves them. */
  async function userWithWorkspace(overrides: Parameters<typeof user>[0] = {}) {
    const created = await user(overrides);
    const org = await organization(created.id, { name: created.name, personal: true });
    return { user: created, org };
  }

  function todo(
    orgId: string,
    createdById: string,
    overrides: { title?: string; completed?: boolean } = {},
  ) {
    return tenantTx(db, orgId, (tx) =>
      tx.todo.create({
        data: {
          orgId,
          createdById,
          title: overrides.title ?? `Todo ${unique()}`,
          completed: overrides.completed ?? false,
        },
      }),
    );
  }

  return { user, organization, member, userWithWorkspace, todo };
}
