/**
 * Kubernetes-style health endpoints for every service.
 *
 * - GET /health/live   the process is up (restart the pod if this fails)
 * - GET /health/ready  dependencies are reachable (stop routing traffic if this fails)
 *
 * Readiness checks each dependency the service registered (Postgres, Redis, ...), so a
 * database outage drains traffic instead of serving errors.
 */
import { Controller, type DynamicModule, Get, Inject, Module, Optional } from "@nestjs/common";
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
  TerminusModule,
} from "@nestjs/terminus";
import type { Database } from "@repo/db";
import type { Redis } from "ioredis";
import { DATABASE } from "./database";
import { REDIS } from "./redis";

export type Dependency = "db" | "redis";

const DEPENDENCIES = Symbol("HEALTH_DEPENDENCIES");

@Controller("health")
class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    @Inject(DEPENDENCIES) private readonly deps: Dependency[],
    // Optional: a service that doesn't use Redis simply hasn't registered it.
    @Optional() @Inject(DATABASE) private readonly database?: Database,
    @Optional() @Inject(REDIS) private readonly redis?: Redis,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  @HealthCheck()
  ready() {
    return this.health.check(this.deps.map((dep) => () => this.check(dep)));
  }

  private async check(dep: Dependency) {
    const status = this.indicator.check(dep);
    try {
      if (dep === "db") {
        if (!this.database) throw new Error("DatabaseModule is not registered");
        await this.database.write.$queryRaw`SELECT 1`;
      }
      if (dep === "redis") {
        if (!this.redis) throw new Error("RedisModule is not registered");
        await this.redis.ping();
      }
      return status.up();
    } catch (error) {
      // Prisma, ioredis and the checks above all throw Errors.
      return status.down({ message: (error as Error).message });
    }
  }
}

@Module({})
export class HealthModule {
  static forRoot(dependencies: Dependency[]): DynamicModule {
    return {
      module: HealthModule,
      imports: [TerminusModule.forRoot({ logger: false })],
      controllers: [HealthController],
      providers: [{ provide: DEPENDENCIES, useValue: dependencies }],
    };
  }
}
