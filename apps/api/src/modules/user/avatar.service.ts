/**
 * The profile picture is an avatar upload that apps/worker has checked and re-encoded.
 * `user.image` holds its content path, and the previous picture is deleted when it's
 * replaced (the database queues its stored objects for removal).
 *
 * It's written through better-auth's internal adapter so every cached session sees the
 * new picture at once. Clients can't set `image` themselves (see the user update hook
 * in auth.ts), so it only ever points at a checked file.
 */
import { Injectable } from "@nestjs/common";
import { fileContentPath } from "@repo/contracts/files";
import { type Database, InjectDatabase } from "@repo/nest-common";
import { type Auth, InjectAuth } from "../../auth/auth.module";
import { FilesService } from "../files";

const AVATAR_PATH = /^\/api\/v1\/files\/([0-9a-f-]{36})\/content$/;

@Injectable()
export class AvatarService {
  constructor(
    @InjectAuth() private readonly auth: Auth,
    @InjectDatabase() private readonly database: Database,
    private readonly files: FilesService,
  ) {}

  async set(userId: string, fileId: string | null) {
    if (fileId) await this.files.ready(userId, fileId, "avatar");
    const current = await this.database.read.user.findUniqueOrThrow({
      where: { id: userId },
      select: { image: true },
    });
    const previous = AVATAR_PATH.exec(current.image ?? "")?.[1];
    const context = await this.auth.$context;
    await context.internalAdapter.updateUser(userId, {
      image: fileId ? fileContentPath(fileId) : null,
    });
    if (previous && previous !== fileId) await this.files.remove(userId, previous);
  }
}
