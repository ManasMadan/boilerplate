import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { queuePrefix } from "@repo/jobs";
import { MaintenanceProcessor } from "./maintenance.processor";

@Module({
  imports: [BullModule.registerQueue({ name: "maintenance", prefix: queuePrefix("maintenance") })],
  providers: [MaintenanceProcessor],
  exports: [MaintenanceProcessor],
})
export class MaintenanceModule {}
