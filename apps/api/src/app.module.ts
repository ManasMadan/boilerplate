import { Module } from "@nestjs/common";
import {
  ClockModule,
  DatabaseModule,
  HealthModule,
  I18nModule,
  LoggerModule,
  RedisModule,
} from "@repo/nest-common";
import { AuthModule } from "./auth/auth.module";
import { env } from "./env";
import { AiModule } from "./modules/ai";
import { AuditModule } from "./modules/audit";
import { FilesModule } from "./modules/files";
import { NotificationsModule } from "./modules/notifications";
import { RealtimeModule } from "./modules/realtime";
import { TodoModule } from "./modules/todo";
import { UserModule } from "./modules/user";
import { WebhooksModule } from "./modules/webhooks";
import { NotificationsProducerModule } from "./notifications";

@Module({
  imports: [
    LoggerModule.forRoot({
      service: "api",
      level: env.LOG_LEVEL,
      pretty: env.NODE_ENV === "development",
    }),
    DatabaseModule.forRoot({
      url: env.API_DATABASE_URL,
      poolMax: env.API_DATABASE_POOL_MAX,
      service: "api",
    }),
    RedisModule.forRoot({ url: env.REDIS_URL }),
    HealthModule.forRoot(["db", "redis"]),
    ClockModule,
    I18nModule.forRoot(),
    NotificationsProducerModule,
    AuthModule,
    TodoModule,
    UserModule,
    AiModule,
    AuditModule,
    WebhooksModule,
    RealtimeModule,
    NotificationsModule,
    FilesModule,
  ],
})
export class AppModule {}
