/**
 * Webhook secret envelope encryption.
 *
 * The user-provided webhook secret must be retrievable to HMAC-sign each
 * delivery payload. We don't want it stored in plaintext, so we wrap it with
 * AES-256-GCM keyed off WEBHOOK_SECRETS_KEY (64 hex chars / 32 bytes in env).
 *
 * Envelope format:  v1:<base64url(iv)>:<base64url(ciphertext)>:<base64url(tag)>
 *  - iv:           12 random bytes (GCM-standard length)
 *  - ciphertext:   AES-256-GCM ciphertext of the UTF-8 secret bytes
 *  - tag:          16-byte GCM auth tag
 *
 * The `v1:` prefix lets us rotate to a new scheme later (re-encrypt-in-place
 * migration). All segments are base64url so the envelope is safe to put in a
 * plain `text` column without escaping.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from '../../config/env.js'

const IV_LEN = 12
const TAG_LEN = 16
const VERSION = 'v1'

function key(): Buffer {
  // env validator enforces 64 hex chars; this assert is belt-and-braces.
  if (!/^[0-9a-fA-F]{64}$/.test(env.WEBHOOK_SECRETS_KEY)) {
    throw new Error('WEBHOOK_SECRETS_KEY must be 64 hex chars (32 bytes)')
  }
  return Buffer.from(env.WEBHOOK_SECRETS_KEY, 'hex')
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url')
}

export function sealSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, b64url(iv), b64url(enc), b64url(tag)].join(':')
}

export function openSecret(envelope: string): string {
  const parts = envelope.split(':')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(`Unrecognised webhook secret envelope (parts=${parts.length})`)
  }
  const iv = fromB64url(parts[1]!)
  const enc = fromB64url(parts[2]!)
  const tag = fromB64url(parts[3]!)
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error('Webhook secret envelope has invalid iv/tag length')
  }
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  const out = Buffer.concat([decipher.update(enc), decipher.final()])
  return out.toString('utf8')
}
