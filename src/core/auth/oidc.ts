/**
 * OIDC client setup + ID token verification for the form-api admin session.
 *
 * Mirrors cms-api/src/core/auth/oidc.ts exactly, using FORMS_OIDC_* env vars.
 * openid-client v6 is used for JWKS discovery and caching.
 *
 * The form-admin performs the full PKCE/auth-code flow in-browser, then sends
 * the resulting id_token to form-api POST /admin/session.  This module verifies
 * that id_token signature + claims.
 *
 * Auth-server unreachable: discovery errors surface as OidcDiscoveryError
 * so callers can return 503 rather than 500.
 */

import * as client from "openid-client";
import { env } from "../../config/env.js";
import pino from "pino";

const logger = pino({ name: "form:oidc" });

// ---------------------------------------------------------------------------
// Lazy singleton — configuration is fetched on first use and cached.
// ---------------------------------------------------------------------------

let _config: client.Configuration | null = null;
let _configFetchedAt: number | null = null;
const CONFIG_TTL_MS = 5 * 60 * 1000; // re-discover every 5 minutes

export class OidcDiscoveryError extends Error {
  readonly code = "oidc_discovery_failed";
  constructor(cause: unknown) {
    const issuer = env.FORMS_OIDC_ISSUER_URL ?? "(not set)";
    super(
      `OIDC discovery failed for ${issuer}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "OidcDiscoveryError";
  }
}

export class OidcTokenVerificationError extends Error {
  readonly code = "oidc_token_invalid";
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "OidcTokenVerificationError";
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Returns a cached (or freshly fetched) openid-client Configuration.
 * Throws OidcDiscoveryError if auth-server is unreachable or issuer not configured.
 */
export async function getOidcConfig(): Promise<client.Configuration> {
  if (!env.FORMS_OIDC_ISSUER_URL) {
    throw new OidcDiscoveryError("FORMS_OIDC_ISSUER_URL is not set");
  }

  const now = Date.now();
  if (
    _config !== null &&
    _configFetchedAt !== null &&
    now - _configFetchedAt < CONFIG_TTL_MS
  ) {
    return _config;
  }

  logger.debug(
    { issuer: env.FORMS_OIDC_ISSUER_URL },
    "Fetching OIDC discovery document"
  );

  try {
    const issuerUrl = new URL(env.FORMS_OIDC_ISSUER_URL);
    const clientAuth = env.FORMS_OIDC_CLIENT_SECRET
      ? client.ClientSecretPost(env.FORMS_OIDC_CLIENT_SECRET)
      : client.None();

    const config = await client.discovery(
      issuerUrl,
      env.FORMS_OIDC_CLIENT_ID,
      {},
      clientAuth,
      // Allow HTTP in non-production environments (local auth-server)
      env.NODE_ENV !== "production"
        ? { execute: [client.allowInsecureRequests] }
        : undefined
    );

    _config = config;
    _configFetchedAt = Date.now();
    logger.info(
      { issuer: env.FORMS_OIDC_ISSUER_URL },
      "OIDC discovery success"
    );
    return config;
  } catch (err) {
    _config = null;
    _configFetchedAt = null;
    logger.warn({ err }, "OIDC discovery failed");
    throw new OidcDiscoveryError(err);
  }
}

/**
 * Verifies an ID token received from form-admin (post-PKCE callback).
 *
 * Checks:
 *  - Signature against auth-server JWKS (fetched/cached via jose)
 *  - issuer matches FORMS_OIDC_ISSUER_URL
 *  - audience matches FORMS_OIDC_CLIENT_ID
 *  - exp / iat / nbf
 *
 * Returns the verified claims object.
 * Throws OidcDiscoveryError or OidcTokenVerificationError on failure.
 */
export interface VerifiedIdTokenClaims {
  sub: string;
  email?: string;
  name?: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string | string[];
}

export async function verifyIdToken(
  idToken: string
): Promise<VerifiedIdTokenClaims> {
  if (!env.FORMS_OIDC_ISSUER_URL) {
    throw new OidcDiscoveryError("FORMS_OIDC_ISSUER_URL is not set");
  }

  const { createRemoteJWKSet, jwtVerify } = await import("jose");

  const jwksUri = new URL(
    `${env.FORMS_OIDC_ISSUER_URL}/.well-known/jwks.json`
  );

  // createRemoteJWKSet caches the keyset automatically; re-fetches on unknown kid
  const JWKS = createRemoteJWKSet(jwksUri, {
    cacheMaxAge: 5 * 60 * 1000,
  });

  try {
    const { payload } = await jwtVerify(idToken, JWKS, {
      issuer: env.FORMS_OIDC_ISSUER_URL,
      audience: env.FORMS_OIDC_CLIENT_ID,
      algorithms: ["RS256", "ES256", "PS256"],
    });

    if (typeof payload["sub"] !== "string" || !payload["sub"]) {
      throw new OidcTokenVerificationError(
        "ID token missing or invalid 'sub' claim"
      );
    }

    return {
      sub: payload["sub"],
      email:
        typeof payload["email"] === "string" ? payload["email"] : undefined,
      name: typeof payload["name"] === "string" ? payload["name"] : undefined,
      iat: typeof payload["iat"] === "number" ? payload["iat"] : 0,
      exp: typeof payload["exp"] === "number" ? payload["exp"] : 0,
      iss: typeof payload["iss"] === "string" ? payload["iss"] : "",
      aud: payload["aud"] as string | string[],
    };
  } catch (err) {
    if (err instanceof OidcTokenVerificationError) throw err;
    throw new OidcTokenVerificationError(
      `ID token verification failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err
    );
  }
}

/**
 * Invalidates the cached OIDC configuration. Useful in tests.
 */
export function resetOidcConfigCache(): void {
  _config = null;
  _configFetchedAt = null;
}
