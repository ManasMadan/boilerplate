/**
 * Uploads (see packages/contracts api/files for the flow). The API only ever signs an
 * upload for exactly the file the client described, into quarantine; nothing uploaded
 * is served until apps/worker has checked it and moved it to `files/<id>`.
 */
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { FileInfo } from "@repo/contracts/api";
import {
  type FileRejection,
  type FileStatus,
  type UploadPurpose,
  uploadPurposes,
} from "@repo/contracts/files";
import { withUser } from "@repo/db";
import type { Producer } from "@repo/jobs";
import {
  AppError,
  createRateLimiter,
  type Database,
  InjectDatabase,
  InjectRedis,
  type Redis,
  STORAGE,
  type Storage,
} from "@repo/nest-common";

export const FILES_QUEUE = Symbol("FILES_QUEUE");

// Signed upload URLs are short-lived: long enough for a slow connection, no longer.
const UPLOAD_EXPIRES_IN = 10 * 60;
const DOWNLOAD_EXPIRES_IN = 5 * 60;

const quarantineKey = (fileId: string) => `quarantine/${fileId}`;
const storedKey = (fileId: string) => `files/${fileId}`;

interface FileRow {
  id: string;
  purpose: string;
  status: string;
  filename: string;
  contentType: string | null;
  size: number | null;
  rejectReason: string | null;
  createdAt: Date;
}

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

const toInfo = (row: FileRow): FileInfo => ({
  id: row.id,
  purpose: row.purpose as UploadPurpose,
  status: row.status as FileStatus,
  filename: row.filename,
  contentType: row.contentType,
  size: row.size,
  rejectReason: row.rejectReason as FileRejection | null,
  createdAt: row.createdAt,
});

@Injectable()
export class FilesService {
  private readonly uploads;

  constructor(
    @InjectDatabase() private readonly database: Database,
    @Inject(STORAGE) private readonly optionalStorage: Storage | null,
    @Inject(FILES_QUEUE) private readonly queue: Producer<"files">,
    @InjectRedis() redis: Redis,
  ) {
    this.uploads = createRateLimiter(redis, {
      name: "file-uploads",
      points: 30,
      windowSeconds: 60 * 60,
    });
  }

  private get storage() {
    if (!this.optionalStorage)
      throw new AppError("FEATURE_DISABLED", { params: { feature: "files" } });
    return this.optionalStorage;
  }

  async createUpload(
    userId: string,
    input: { purpose: UploadPurpose; filename: string; contentType: string; size: number },
  ) {
    const storage = this.storage;
    const rules = uploadPurposes[input.purpose];
    if (!(rules.types as readonly string[]).includes(input.contentType)) {
      throw new AppError("FILE_TYPE_NOT_ALLOWED", { params: { types: rules.types.join(", ") } });
    }
    if (input.size > rules.maxBytes) {
      throw new AppError("FILE_TOO_LARGE", { params: { maxBytes: rules.maxBytes } });
    }
    const limit = await this.uploads.consume(userId);
    if (!limit.allowed) {
      throw new AppError("RATE_LIMITED", {
        params: { retryAfterSeconds: limit.retryAfterSeconds },
      });
    }
    const id = randomUUID();
    const row = await withUser(this.database.write, userId).file.create({
      data: {
        id,
        userId,
        purpose: input.purpose,
        filename: input.filename,
        declaredType: input.contentType,
        declaredSize: input.size,
      },
      select,
    });
    const upload = await storage.presignUpload({
      key: quarantineKey(id),
      contentType: input.contentType,
      contentLength: input.size,
      expiresInSeconds: UPLOAD_EXPIRES_IN,
    });
    return { file: toInfo(row), upload };
  }

  /** Queues the check. Idempotent: completing twice (or after it's checked) is fine. */
  async complete(userId: string, fileId: string) {
    const storage = this.storage;
    const row = await this.find(userId, fileId);
    if (row.status !== "pending") return toInfo(row);
    if (!(await storage.head(quarantineKey(fileId)))) throw new AppError("FILE_NOT_UPLOADED");
    await this.queue.add("process", { fileId }, { jobId: fileId });
    return toInfo(row);
  }

  async get(userId: string, fileId: string) {
    return toInfo(await this.find(userId, fileId));
  }

  /** A ready file of the user's, for `purpose` (FILE_NOT_READY / FILE_NOT_FOUND). */
  async ready(userId: string, fileId: string, purpose: UploadPurpose) {
    const row = await this.find(userId, fileId);
    if (row.purpose !== purpose) throw new AppError("FILE_NOT_FOUND");
    if (row.status !== "ready") throw new AppError("FILE_NOT_READY");
    return toInfo(row);
  }

  /** Deletes the row; the database queues its stored objects for removal. */
  async remove(userId: string, fileId: string) {
    await withUser(this.database.write, userId).file.deleteMany({ where: { id: fileId, userId } });
  }

  /**
   * A short-lived URL for a ready file the viewer may read (their own, or anyone's
   * avatar: row-level security decides). Null when there's no such file.
   */
  async downloadUrl(viewerId: string, fileId: string) {
    const row = await withUser(this.database.read, viewerId).file.findFirst({
      where: { id: fileId, status: "ready" },
      select: { purpose: true, filename: true },
    });
    if (!row) return null;
    return this.storage.presignDownload(storedKey(fileId), {
      expiresInSeconds: DOWNLOAD_EXPIRES_IN,
      // Images are shown inline; anything else downloads rather than opening.
      ...(row.purpose !== "avatar" && { filename: row.filename }),
    });
  }

  private async find(userId: string, fileId: string) {
    const row = await withUser(this.database.read, userId).file.findFirst({
      where: { id: fileId, userId },
      select,
    });
    if (!row) throw new AppError("FILE_NOT_FOUND");
    return row;
  }
}
