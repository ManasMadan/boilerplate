/**
 * Data access for uploads. Every query runs through withUser, so row-level security
 * scopes it to the caller (who may also read anyone's ready avatar).
 */
import { Injectable } from "@nestjs/common";
import { withUser } from "@repo/db";
import { type Database, InjectDatabase } from "@repo/nest-common";

const select = {
  id: true,
  purpose: true,
  status: true,
  filename: true,
  contentType: true,
  size: true,
  rejectReason: true,
  createdAt: true,
} as const;

@Injectable()
export class FilesRepository {
  constructor(@InjectDatabase() private readonly database: Database) {}

  create(
    userId: string,
    data: {
      id: string;
      purpose: string;
      filename: string;
      declaredType: string;
      declaredSize: number;
    },
  ) {
    return withUser(this.database.write, userId).file.create({
      data: { ...data, userId },
      select,
    });
  }

  find(userId: string, fileId: string) {
    return withUser(this.database.read, userId).file.findFirst({
      where: { id: fileId, userId },
      select,
    });
  }

  /** A ready file the viewer may read, or null. */
  findReadable(viewerId: string, fileId: string) {
    return withUser(this.database.read, viewerId).file.findFirst({
      where: { id: fileId, status: "ready" },
      select: { purpose: true, filename: true },
    });
  }

  async remove(userId: string, fileId: string) {
    await withUser(this.database.write, userId).file.deleteMany({ where: { id: fileId, userId } });
  }
}
