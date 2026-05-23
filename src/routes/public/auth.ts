/**
 * Public OIDC session endpoint for form-web visitors.
 *
 *   POST /public/auth/session
 *   body { code, code_verifier, redirect_uri }
 *
 * Used by form-web's /auth/callback to mint a *user* session (no RBAC roles)
 * after an auth-server PKCE login. The returned `session_token` is a regular
 * form-api access JWT — the same auth plugin that gates admin routes will
 * populate `request.session` from it for any endpoint that calls
 * `maybeAuthenticate`, which is how /public/forms/:slug/submit picks up an
 * authenticated user's `sub` and stamps it onto the submission row.
 *
 * Distinct from /admin/session in two ways:
 *   - skips lookupOrBootstrapRoles, so non-admin accounts are welcome.
 *   - does the auth-server code→token exchange itself (form-web is a public
 *     PKCE client; we don't expose admin's id-token-only path here).
 */
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { env } from '../../config/env.js'
import {
  verifyIdToken,
  OidcDiscoveryError,
  OidcTokenVerificationError,
} from '../../core/auth/oidc.js'
import { issueSession } from '../../core/auth/session.js'

const bodySchema = z.object({
  code: z.string().min(1),
  code_verifier: z.string().min(1),
  redirect_uri: z.string().url(),
})

interface AuthServerTokenResponse {
  access_token: string
  id_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
}

export const publicAuthRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.post(
    '/public/auth/session',
    {
      schema: {
        tags: ['public', 'auth'],
        body: bodySchema,
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!env.FORMS_OIDC_ISSUER_URL) {
        return reply
          .status(503)
          .send({ error: { code: 'oidc_not_configured', message: 'OIDC issuer not set' } })
      }

      // 1. Exchange code → tokens via auth-server's token endpoint.
      const tokenUrl = `${env.FORMS_OIDC_ISSUER_URL}/v1/oauth2/token`
      const form = new URLSearchParams()
      form.set('grant_type', 'authorization_code')
      form.set('code', request.body.code)
      form.set('code_verifier', request.body.code_verifier)
      form.set('redirect_uri', request.body.redirect_uri)
      form.set('client_id', env.FORMS_OIDC_CLIENT_ID)
      if (env.FORMS_OIDC_CLIENT_SECRET) {
        form.set('client_secret', env.FORMS_OIDC_CLIENT_SECRET)
      }

      let tokenRes: Response
      try {
        tokenRes = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        })
      } catch (err) {
        request.log.warn({ err }, 'public auth: token exchange network error')
        return reply.status(503).send({
          error: { code: 'auth_server_unreachable', message: 'Auth server unreachable' },
        })
      }

      if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => '')
        request.log.info({ status: tokenRes.status, text }, 'auth-server token exchange failed')
        return reply
          .status(401)
          .send({ error: { code: 'invalid_code', message: 'Authorization code rejected' } })
      }

      const tokens = (await tokenRes.json()) as AuthServerTokenResponse
      if (!tokens.id_token) {
        return reply
          .status(401)
          .send({ error: { code: 'no_id_token', message: 'OIDC server returned no id_token' } })
      }

      // 2. Verify the id_token (sig + iss + aud + exp).
      let claims: Awaited<ReturnType<typeof verifyIdToken>>
      try {
        claims = await verifyIdToken(tokens.id_token)
      } catch (err) {
        if (err instanceof OidcDiscoveryError) {
          return reply.status(503).send({
            error: {
              code: 'oidc_discovery_failed',
              message: 'Auth server JWKS unreachable',
            },
          })
        }
        if (err instanceof OidcTokenVerificationError) {
          return reply
            .status(401)
            .send({ error: { code: 'invalid_id_token', message: err.message } })
        }
        throw err
      }

      // 3. Issue a form-api session with no roles — pure user identity.
      // Carry the email/name claims into the JWT so /public/forms/:slug/prefill
      // can fill `auth_field`-mapped fields without re-hitting the OIDC server.
      const session = await issueSession(app.prisma, {
        sub: claims.sub,
        roles: [],
        userAgent: request.headers['user-agent'],
        ipHash: request.ip,
        email: claims.email,
        name: claims.name,
      })

      return reply.status(200).send({
        session_token: session.access_token,
        expires_at: session.expires_at,
        account: {
          sub: claims.sub,
          email: claims.email ?? '',
          name: claims.name ?? '',
          picture: null,
          abilities: [] as string[],
        },
      })
    },
  )
}

export default publicAuthRoutes
