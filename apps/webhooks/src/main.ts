import { env } from "./env";
import { createWebhooksServer } from "./server";

const app = await createWebhooksServer();
await app.listen({ port: env.PORT, host: "0.0.0.0" });
