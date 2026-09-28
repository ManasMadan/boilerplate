import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { queuePrefix } from "@repo/jobs";
import { EmailModule } from "../channels/email/email.module";
import { Dispatcher } from "./dispatcher";
import {
  BulkNotificationsProcessor,
  CriticalNotificationsProcessor,
} from "./notifications.processor";
import { RecipientResolver } from "./recipients";
import { CodeTemplateSource, TemplateSource } from "./templates";

@Module({
  imports: [
    BullModule.registerQueue(
      { name: "notifications-critical", prefix: queuePrefix("notifications-critical") },
      { name: "notifications-bulk", prefix: queuePrefix("notifications-bulk") },
    ),
    EmailModule,
  ],
  providers: [
    CriticalNotificationsProcessor,
    BulkNotificationsProcessor,
    Dispatcher,
    RecipientResolver,
    // Swap for a database-backed TemplateSource to edit templates without a deploy.
    { provide: TemplateSource, useClass: CodeTemplateSource },
  ],
})
export class NotificationsModule {}
