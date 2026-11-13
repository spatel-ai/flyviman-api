import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { FilePurpose, Role } from '../../generated/prisma/enums.js';
import { ALLOWED_CONTENT_TYPES } from '../../integrations/storage/file-signature.js';
import {
  SignedDownload,
  SignedUpload,
  StorageProvider,
} from '../../integrations/storage/storage.provider.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-user.js';

/** Largest accepted upload. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Files one user may have reserved but not yet attached to a record. */
export const MAX_PENDING_UPLOADS = 20;
/** How long a reserved upload may wait to be attached before it is dropped. */
export const RESERVATION_SECONDS = 60 * 60;

export interface FileInfo {
  id: string;
  ownerId: string;
  purpose: FilePurpose;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * Decides whether a user may read a file of one purpose. Registered by the
 * module that owns the records the file is attached to.
 */
export type FileAccessCheck = (
  file: FileInfo,
  user: AuthUser,
) => Promise<boolean>;

function notFound(): AppException {
  return new AppException('NOT_FOUND', 'File not found.', HttpStatus.NOT_FOUND);
}

/**
 * Upload authorisation, file metadata and access checks. Files live in
 * private storage and are reached only through short-lived signed URLs.
 */
/** Who may reserve an upload for each purpose: the roles that attach it. */
const PURPOSE_ROLES: Record<FilePurpose, Role[]> = {
  OPERATOR_DOCUMENT: [Role.OPERATOR_ADMIN],
  AIRCRAFT_PHOTO: [Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF],
  AIRCRAFT_FLOOR_PLAN: [Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF],
  AIRCRAFT_DOCUMENT: [Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF],
};

@Injectable()
export class DocumentsService {
  private readonly accessChecks = new Map<FilePurpose, FileAccessCheck>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
  ) {}

  registerAccessCheck(purpose: FilePurpose, check: FileAccessCheck): void {
    this.accessChecks.set(purpose, check);
  }

  /** Step 1 of an upload: reserve a file and get a URL to send it to. */
  async presign(
    user: AuthUser,
    input: {
      purpose: FilePurpose;
      fileName: string;
      contentType: string;
      sizeBytes: number;
    },
  ): Promise<{ fileId: string; upload: SignedUpload }> {
    // A slot can be reserved only by a role that could attach the file
    // (M3 close-out security review).
    if (!PURPOSE_ROLES[input.purpose]?.includes(user.role)) {
      throw new AppException(
        'FORBIDDEN',
        'You cannot upload this kind of file.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!ALLOWED_CONTENT_TYPES.includes(input.contentType)) {
      throw new AppException(
        'VALIDATION_ERROR',
        'This file type is not accepted.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'contentType', issue: 'must be a PDF, JPEG or PNG' }],
      );
    }
    if (input.sizeBytes > MAX_UPLOAD_BYTES) {
      throw new AppException(
        'VALIDATION_ERROR',
        'The file is larger than allowed.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'sizeBytes', issue: 'must be 10 MB or smaller' }],
      );
    }

    // Uploads reserved but never attached to anything are capped per user,
    // so storage cannot be filled by reserving files.
    await this.discardAbandoned(user.id);
    const pending = await this.prisma.storedFile.count({
      where: { ownerId: user.id, uploadedAt: null },
    });
    if (pending >= MAX_PENDING_UPLOADS) {
      throw new AppException(
        'UPLOAD_LIMIT_REACHED',
        'You have too many unfinished uploads. Finish or wait before adding more.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // The key is ours alone: nothing the client sends becomes part of a path.
    const storageKey = `${input.purpose.toLowerCase()}/${randomUUID()}`;
    const file = await this.prisma.storedFile.create({
      data: {
        ownerId: user.id,
        purpose: input.purpose,
        storageKey,
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
      },
    });
    const upload = await this.storage.createUploadUrl({
      key: storageKey,
      contentType: input.contentType,
      maxBytes: MAX_UPLOAD_BYTES,
    });
    return { fileId: file.id, upload };
  }

  /** Removes this user's reservations that were never attached in time. */
  private async discardAbandoned(ownerId: string): Promise<void> {
    const abandoned = await this.prisma.storedFile.findMany({
      where: {
        ownerId,
        uploadedAt: null,
        createdAt: { lt: new Date(Date.now() - RESERVATION_SECONDS * 1000) },
      },
      select: { id: true, storageKey: true },
    });
    if (abandoned.length === 0) return;
    await this.prisma.storedFile.deleteMany({
      where: { id: { in: abandoned.map((file) => file.id) }, uploadedAt: null },
    });
    await Promise.all(
      abandoned.map((file) => this.storage.delete(file.storageKey)),
    );
  }

  /**
   * Step 2: confirm the upload arrived so the file can be attached to a
   * record. Only the user who reserved it can, and only once.
   */
  async claim(
    fileId: string,
    ownerId: string,
    purpose: FilePurpose,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<FileInfo> {
    const file = await db.storedFile.findFirst({
      where: { id: fileId, ownerId, purpose, uploadedAt: null },
    });
    const stored = file ? await this.storage.stat(file.storageKey) : null;
    if (!file || !stored || stored.sizeBytes > MAX_UPLOAD_BYTES) {
      throw new AppException(
        'UPLOAD_NOT_FOUND',
        'The uploaded file was not found. Upload it again.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'fileId', issue: 'no completed upload for this file' }],
      );
    }
    return db.storedFile.update({
      where: { id: file.id },
      data: { uploadedAt: new Date(), sizeBytes: stored.sizeBytes },
    });
  }

  async describe(fileIds: string[]): Promise<Map<string, FileInfo>> {
    const files = await this.prisma.storedFile.findMany({
      where: { id: { in: fileIds } },
    });
    return new Map(files.map((file) => [file.id, file]));
  }

  /** A download link, if this user may read the file. Otherwise not found. */
  async downloadFor(user: AuthUser, fileId: string): Promise<SignedDownload> {
    const file = await this.prisma.storedFile.findFirst({
      where: { id: fileId, uploadedAt: { not: null } },
    });
    if (!file) throw notFound();

    const check = this.accessChecks.get(file.purpose);
    const allowed = check ? await check(file, user) : file.ownerId === user.id;
    if (!allowed) throw notFound();

    return this.storage.createDownloadUrl({
      key: file.storageKey,
      fileName: file.fileName,
      contentType: file.contentType,
    });
  }

  async remove(fileId: string): Promise<void> {
    const file = await this.prisma.storedFile.findUnique({
      where: { id: fileId },
    });
    if (!file) return;
    await this.prisma.storedFile.delete({ where: { id: fileId } });
    await this.storage.delete(file.storageKey);
  }
}
