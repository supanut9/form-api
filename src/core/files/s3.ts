/**
 * Lazy-init S3Client pointed at the configured S3 endpoint.
 *
 * Path-style addressing is enabled so the same client works against AWS S3
 * (virtual host style accepted) and MinIO (which only accepts path style).
 */
import { S3Client } from '@aws-sdk/client-s3'
import { env } from '../../config/env.js'

let _s3: S3Client | null = null

export function getS3(): S3Client {
  if (_s3) return _s3
  _s3 = new S3Client({
    region: env.S3_REGION ?? 'us-east-1',
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    },
  })
  return _s3
}

export const S3_BUCKET = env.S3_BUCKET
