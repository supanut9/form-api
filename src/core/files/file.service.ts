/**
 * File-upload service.
 *
 * Phase-1 flow:
 *   1. Browser → POST /public/files/presign  → { upload_url, storage_key, file_id }
 *   2. Browser → PUT   <upload_url>           → MinIO/S3 stores the bytes
 *   3. Browser → POST /public/files/confirm   → server verifies HEAD, marks row
 *   4. Submission payload includes the file_id (string) per field.
 *   5. On submit, server links file rows to the new submission_id.
 *
 * Admin download:
 *   GET /admin/files/:id/download → presigned GET URL (5-minute expiry).
 */
import { HeadObjectCommand, PutObjectCommand, GetObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomBytes } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { getS3, S3_BUCKET } from './s3.js'

const DEFAULT_PRESIGN_TTL = 300 // 5 minutes
const MAX_DEFAULT_SIZE_BYTES = 10 * 1024 * 1024 // 10MB

let bucketEnsured = false

async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return
  const s3 = getS3()
  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }))
    bucketEnsured = true
  } catch {
    // CreateBucket is idempotent for owned buckets; harmless to call on a 404 head.
    await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }))
    bucketEnsured = true
  }
}

export class FileService {
  constructor(private readonly prisma: PrismaClient) {}

  async presignUpload(input: {
    filename: string
    contentType: string
    size: number
    formId?: string | null
    accountId?: string | null
    anonymousToken?: string | null
    /** Optional spec-derived size cap; falls back to MAX_DEFAULT_SIZE_BYTES. */
    maxSizeBytes?: number
    allowedMimeTypes?: string[]
  }) {
    const max = input.maxSizeBytes ?? MAX_DEFAULT_SIZE_BYTES
    if (!Number.isFinite(input.size) || input.size <= 0 || input.size > max) {
      const err = new Error(`File size ${input.size} bytes exceeds limit (${max})`) as Error & { code?: string }
      err.code = 'file_too_large'
      throw err
    }

    if (
      input.allowedMimeTypes &&
      input.allowedMimeTypes.length > 0 &&
      !input.allowedMimeTypes.includes(input.contentType)
    ) {
      const err = new Error(
        `Mime ${input.contentType} not in allowlist [${input.allowedMimeTypes.join(', ')}]`,
      ) as Error & { code?: string }
      err.code = 'mime_not_allowed'
      throw err
    }

    await ensureBucket()

    // Storage key embeds form_id + a random fragment + sanitized filename.
    const safeName = input.filename.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)
    const formSegment = input.formId ?? 'orphan'
    const randomSegment = randomBytes(8).toString('base64url')
    const storageKey = `forms/${formSegment}/${randomSegment}-${safeName}`

    // Create the FormFile row in `pending` state (no sha256 yet — captured on confirm).
    const row = await this.prisma.formFile.create({
      data: {
        formId: input.formId ?? null,
        accountId: input.accountId ?? null,
        storageKey,
        mime: input.contentType,
        size: BigInt(input.size),
        sha256: '', // filled at confirm time
      },
      select: { id: true, storageKey: true },
    })

    const s3 = getS3()
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: storageKey,
      ContentType: input.contentType,
      ContentLength: input.size,
    })
    const uploadUrl = await getSignedUrl(s3, command, {
      expiresIn: DEFAULT_PRESIGN_TTL,
    })

    return {
      file_id: row.id,
      storage_key: row.storageKey,
      upload_url: uploadUrl,
      expires_in: DEFAULT_PRESIGN_TTL,
    }
  }

  /**
   * Confirm a previously-presigned upload. Verifies the object exists in S3
   * (HEAD) and matches the announced size, then stores the client-provided
   * sha256 hash for integrity.
   */
  async confirmUpload(input: { fileId: string; sha256: string }) {
    const row = await this.prisma.formFile.findUnique({ where: { id: input.fileId } })
    if (!row) {
      const err = new Error('File not found') as Error & { code?: string }
      err.code = 'not_found'
      throw err
    }

    const s3 = getS3()
    const head = await s3
      .send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: row.storageKey }))
      .catch(() => null)
    if (!head) {
      const err = new Error(
        'Object not found in storage — upload may have failed or expired',
      ) as Error & { code?: string }
      err.code = 'object_missing'
      throw err
    }

    if (head.ContentLength != null && BigInt(head.ContentLength) !== row.size) {
      const err = new Error(
        `Uploaded size ${head.ContentLength} does not match presigned ${row.size.toString()}`,
      ) as Error & { code?: string }
      err.code = 'size_mismatch'
      throw err
    }

    const updated = await this.prisma.formFile.update({
      where: { id: input.fileId },
      data: { sha256: input.sha256 },
    })

    return {
      file_id: updated.id,
      storage_key: updated.storageKey,
      mime: updated.mime,
      size: Number(updated.size),
      sha256: updated.sha256,
    }
  }

  async generateDownloadUrl(fileId: string, ttlSeconds = DEFAULT_PRESIGN_TTL) {
    const row = await this.prisma.formFile.findUnique({ where: { id: fileId } })
    if (!row) return null
    const s3 = getS3()
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: row.storageKey }),
      { expiresIn: ttlSeconds },
    )
    return {
      url,
      mime: row.mime,
      size: Number(row.size),
      filename: row.storageKey.split('/').pop() ?? row.storageKey,
      expires_in: ttlSeconds,
    }
  }

  /**
   * Link every file in `fileIds` to the given submission so it's no longer
   * an orphan. Silently skips ids not found.
   */
  async linkToSubmission(fileIds: string[], submissionId: string) {
    if (fileIds.length === 0) return
    await this.prisma.formFile.updateMany({
      where: { id: { in: fileIds } },
      data: { submissionId },
    })
  }
}
