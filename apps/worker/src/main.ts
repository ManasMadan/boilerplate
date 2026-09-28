import { bootstrap } from "@repo/nest-common";
import { AppModule } from "./app.module";
import { env } from "./env";

await bootstrap(AppModule, {
  port: env.PORT,
  service: "worker",
  logLevel: env.LOG_LEVEL,
  trustedProxies: env.TRUSTED_PROXIES,
});
