import type { Procedures } from "../../rpc/procedures";

export const userRouter = ({ authed }: Procedures) => ({
  me: authed.user.me.handler(({ context: { user, session } }) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image ?? null,
    locale: user.locale ?? "en",
    timezone: user.timezone ?? "UTC",
    activeOrganizationId: session.activeOrganizationId ?? null,
  })),
});
