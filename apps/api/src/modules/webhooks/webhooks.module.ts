import { Module } from "@nestjs/common";
import { createProducer } from "@repo/jobs";
import { REDIS, type Redis } from "@repo/nest-common";
import { WebhooksRepository } from "./webhooks.repository";
import { WEBHOOK_DELIVERIES, WebhooksService } from "./webhooks.service";

@Module({
  providers: [
    WebhooksRepository,
    WebhooksService,
    {
      provide: WEBHOOK_DELIVERIES,
      inject: [REDIS],
      useFactory: (redis: Redis) => createProducer("webhook-deliveries", redis),
    },
  ],
  exports: [WebhooksService],
})
export class WebhooksModule {}
