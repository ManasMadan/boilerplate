import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { queuePrefix } from "@repo/jobs";
import { BillingService } from "./billing.service";
import { BillingEventsProcessor } from "./billing-events.processor";
import { createStripe, STRIPE } from "./stripe";

@Module({
  imports: [
    BullModule.registerQueue({ name: "events-billing", prefix: queuePrefix("events-billing") }),
  ],
  providers: [
    // Null when billing is off: procedures answer FEATURE_DISABLED, entitlements are unlimited.
    { provide: STRIPE, useFactory: createStripe },
    BillingService,
    BillingEventsProcessor,
  ],
  exports: [BillingService],
})
export class BillingModule {}
