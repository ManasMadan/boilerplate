/**
 * Who belongs to which organization, and with what role, as checked on every
 * organization-scoped request.
 *
 * A session only remembers which organization is active; membership can change under it
 * (removed, role changed, organization deleted), so every request re-checks. The answer
 * is cached in Redis for a few minutes, and every membership change in the auth config
 * (organization hooks) forgets it immediately, so a removed member loses access on
 * their very next request.
 */
import type { Db } from "@repo/db";
import { CacheService, type Redis } from "@repo/nest-common";

const TTL_SECONDS = 300;

export type OrgRole = "owner" | "admin" | "member";

export function createMemberships(db: Db, redis: Redis) {
  const cache = new CacheService(redis, "membership");
  const key = (orgId: string, userId: string) => `${orgId}:${userId}`;

  return {
    /** The user's role in the organization, or null when they aren't a member. */
    role(orgId: string, userId: string): Promise<OrgRole | null> {
      return cache.wrap(key(orgId, userId), TTL_SECONDS, async () => {
        const member = await db.member.findFirst({
          where: { organizationId: orgId, userId },
          select: { role: true },
        });
        return (member?.role as OrgRole | undefined) ?? null;
      });
    },
    /** Call after any change to this membership. */
    forget(orgId: string, userId: string) {
      return cache.invalidate(key(orgId, userId));
    },
    /** Call before deleting an organization: forgets every member's cached role. */
    async forgetOrganization(orgId: string) {
      const members = await db.member.findMany({
        where: { organizationId: orgId },
        select: { userId: true },
      });
      await Promise.all(members.map((member) => cache.invalidate(key(orgId, member.userId))));
    },
  };
}

export type Memberships = ReturnType<typeof createMemberships>;
