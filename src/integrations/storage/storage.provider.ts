export interface SignedUpload {
  url: string;
  method: 'PUT';
  /** Headers the client must send with the upload. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface SignedDownload {
  url: string;
  expiresAt: Date;
}

export interface StoredObject {
  sizeBytes: number;
}

/**
 * Private file storage reached only through short-lived signed URLs.
 * Production target is an S3-compatible bucket (docs/open-decisions.md).
 */
export abstract class StorageProvider {
  abstract createUploadUrl(input: {
    key: string;
    contentType: string;
    maxBytes: number;
  }): Promise<SignedUpload>;

  abstract createDownloadUrl(input: {
    key: string;
    fileName: string;
    contentType: string;
  }): Promise<SignedDownload>;

  /** `null` when nothing has been uploaded under the key. */
  abstract stat(key: string): Promise<StoredObject | null>;

  abstract delete(key: string): Promise<void>;
}
