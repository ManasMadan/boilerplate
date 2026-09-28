import { Global, Inject, Module } from "@nestjs/common";
import { DATABASE, type Database, REDIS, type Redis } from "@repo/nest-common";
import { env } from "../env";
import { CRITICAL_NOTIFICATIONS, type CriticalNotifications } from "../notifications";
import { type Auth, createAuth } from "./auth";

export const AUTH = Symbol("AUTH");
export const InjectAuth = () => Inject(AUTH);
export type { Auth };

/** The better-auth instance, built from the service's own database, Redis and queues. */
@Global()
@Module({
  providers: [
    {
      provide: AUTH,
      inject: [DATABASE, REDIS, CRITICAL_NOTIFICATIONS],
      useFactory: (database: Database, redis: Redis, notifications: CriticalNotifications) =>
        createAuth({ env, db: database.write, redis, notifications }),
    },
  ],
  exports: [AUTH],
})
export class AuthModule {}
