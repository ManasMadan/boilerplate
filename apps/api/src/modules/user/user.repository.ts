/**
 * Data access for the account fields this module owns (the phone number) or reads
 * (the profile picture). The user table has no row-level security; each query names
 * its user.
 */
import { Injectable } from "@nestjs/common";
import type { Tx } from "@repo/db";
import { type Database, InjectDatabase } from "@repo/nest-common";

@Injectable()
export class UserRepository {
  constructor(@InjectDatabase() private readonly database: Database) {}

  phoneNumber(userId: string) {
    return this.database.read.user.findUnique({
      where: { id: userId },
      select: { phoneNumber: true },
    });
  }

  image(userId: string) {
    return this.database.read.user.findUniqueOrThrow({
      where: { id: userId },
      select: { image: true },
    });
  }

  phoneNumberIn(tx: Tx, userId: string) {
    return tx.user.findUniqueOrThrow({ where: { id: userId }, select: { phoneNumber: true } });
  }

  setPhoneNumber(tx: Tx, userId: string, phoneNumber: string | null) {
    return tx.user.update({ where: { id: userId }, data: { phoneNumber } });
  }
}
