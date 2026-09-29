/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { ApiKeysService } from "./api-keys.service";

export const apiKeysRouter = ({ orgAdmin }: Procedures, keys: ApiKeysService) => ({
  list: orgAdmin.apiKeys.list.handler(({ context }) => keys.list(context.orgId)),
  create: orgAdmin.apiKeys.create.handler(({ context, input }) =>
    keys.create(context.orgId, context.userId, input),
  ),
  revoke: orgAdmin.apiKeys.revoke.handler(({ context, input }) =>
    keys.revoke(context.orgId, context.userId, input.id),
  ),
});
