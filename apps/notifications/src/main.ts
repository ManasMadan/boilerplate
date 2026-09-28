import { bootstrap } from "@repo/nest-common";
import { AppModule } from "./app.module";
import { env } from "./env";

await bootstrap(AppModule, { port: env.PORT, trustedProxies: env.TRUSTED_PROXIES });
