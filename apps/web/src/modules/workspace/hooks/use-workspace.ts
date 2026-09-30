"use client";

/**
 * The signed-in user's workspaces (better-auth organizations) and their role in the
 * active one, as TanStack queries, plus switching. Switching changes which workspace
 * every API call works in, so all cached data is refetched.
 */
import { canManageWorkspace, parseOrgRole } from "@repo/contracts/roles";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

const keys = {
  all: ["auth", "workspace"] as const,
  list: ["auth", "workspace", "list"] as const,
  active: (id: string | null | undefined) => ["auth", "workspace", "active", id] as const,
};

async function unwrap<T>(call: Promise<{ data: T | null; error: unknown }>): Promise<T> {
  const { data, error } = await call;
  if (error) throw error;
  if (data === null) throw new Error("Empty response");
  return data;
}

/** Personal workspaces (one per user, created at sign-up) can't be shared or deleted. */
export function isPersonal(organization: { metadata?: unknown }) {
  if (typeof organization.metadata !== "string") return false;
  try {
    return (JSON.parse(organization.metadata) as { personal?: boolean }).personal === true;
  } catch {
    return false;
  }
}

export function useWorkspaces() {
  return useQuery({ queryKey: keys.list, queryFn: () => unwrap(authClient.organization.list()) });
}

/** The active workspace with its members and invitations, and the user's role in it. */
export function useActiveWorkspace() {
  const { data: session } = authClient.useSession();
  const activeId = session?.session.activeOrganizationId;
  const userId = session?.user.id;
  const query = useQuery({
    queryKey: keys.active(activeId),
    enabled: Boolean(activeId),
    queryFn: () => unwrap(authClient.organization.getFullOrganization()),
  });
  // Parsed, not cast: a role the app doesn't know grants nothing (@repo/contracts/roles).
  const role = parseOrgRole(query.data?.members.find((member) => member.userId === userId)?.role);
  return { ...query, role, userId, isAdmin: canManageWorkspace(role) };
}

/** Refetches workspace data (after membership or settings changes). */
export function useRefreshWorkspaces() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: keys.all });
}

export function useSwitchWorkspace() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { refetch } = authClient.useSession();
  return async (organizationId: string) => {
    const { error } = await authClient.organization.setActive({ organizationId });
    if (error) throw error;
    await refetch();
    // Every cached query belonged to the previous workspace.
    await queryClient.invalidateQueries();
    router.refresh();
  };
}
