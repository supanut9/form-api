/**
 * API token service.
 *
 * Tokens are returned ONCE on creation. Only their sha256 hash is stored so
 * a database leak can't be used to call back into the API.
 *
 * Verification (`verifyToken`) is used by internal endpoints that accept
 * Bearer tokens rather than admin sessions (e.g. service-to-service calls,
 * webhook receivers querying status).
 */
import { createHash, randomBytes } from 'node:crypto'
import type { PrismaClient, ApiTokenType, ApiToken } from '@prisma/client'

const TOKEN_PREFIX = 'fak_' // form-api-key

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export interface IssueTokenInput {
  name: string
  type: ApiTokenType
  scopes: string[]
  expiresAt?: Date | null
}

export interface IssueTokenResult {
  /** Raw bearer token — show ONCE to caller. Never persisted. */
  token: string
  row: ApiToken
}

export class TokenService {
  constructor(private readonly prisma: PrismaClient) {}

  async issueToken(input: IssueTokenInput): Promise<IssueTokenResult> {
    const raw = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`
    const row = await this.prisma.apiToken.create({
      data: {
        name: input.name,
        tokenHash: hashToken(raw),
        type: input.type,
        scopesJson: input.scopes as object,
        expiresAt: input.expiresAt ?? null,
      },
    })
    return { token: raw, row }
  }

  async listTokens(includeRevoked = false) {
    return this.prisma.apiToken.findMany({
      where: includeRevoked ? {} : { revokedAt: null },
      orderBy: { createdAt: 'desc' },
    })
  }

  async getToken(id: string) {
    return this.prisma.apiToken.findUnique({ where: { id } })
  }

  async revokeToken(id: string): Promise<ApiToken | null> {
    try {
      return await this.prisma.apiToken.update({
        where: { id },
        data: { revokedAt: new Date() },
      })
    } catch {
      return null
    }
  }

  async deleteToken(id: string): Promise<boolean> {
    try {
      await this.prisma.apiToken.delete({ where: { id } })
      return true
    } catch {
      return false
    }
  }

  /**
   * Verify a bearer token. Returns the row if it's currently valid (not
   * revoked, not expired). Used by service-token preHandlers.
   */
  async verifyToken(raw: string): Promise<ApiToken | null> {
    if (!raw.startsWith(TOKEN_PREFIX)) return null
    const row = await this.prisma.apiToken.findUnique({
      where: { tokenHash: hashToken(raw) },
    })
    if (!row) return null
    if (row.revokedAt) return null
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null
    return row
  }
}
