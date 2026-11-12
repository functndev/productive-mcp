// Minimal OpenID Connect client (authorization code + PKCE, RS256 ID tokens) over fetch and Web
// Crypto, for Cloudflare Access for SaaS as the identity provider.
//
// From the functn Tracking MCP's packages/core/src/oidc.ts (the newest copy), with `nbf` checked and
// the base64url helpers inlined. functn-it's proposed mcp/ topic plans this as a shared `oidc.ts`;
// replace this file with that copy once it exists.

export interface OidcClientConfig {
  /** e.g. https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id> */
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | Array<string>;
  exp: number;
  nbf?: number;
  iat?: number;
  email?: string;
  name?: string;
  [claim: string]: unknown;
}

/** Each call to the identity provider (discovery, token, keys); a person or Claude is waiting (functn-it stack/). */
export const OIDC_TIMEOUT_MS = 15_000;

export class OidcError extends Error {
  override name = "OidcError";
}

/** A refresh the provider refused for good (revoked, expired, or the user no longer passes policy). */
export class OidcRefreshDenied extends OidcError {
  override name = "OidcRefreshDenied";
}

/** The provider didn't answer, not in time, or with a 5xx: worth a retry, not the person's fault. */
export class OidcUnavailable extends OidcError {
  override name = "OidcUnavailable";
}

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export function randomToken(byteLength = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** PKCE S256 code challenge for a verifier. */
export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** A fetch to the provider; no answer becomes OidcUnavailable. */
async function providerFetch(what: string, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(OIDC_TIMEOUT_MS) });
  } catch (error) {
    throw new OidcUnavailable(`${what}: no answer from the identity provider`, { cause: error });
  }
}

const discoveryCache = new Map<string, Promise<Discovery>>();

export function discover(issuer: string): Promise<Discovery> {
  let cached = discoveryCache.get(issuer);
  if (!cached) {
    cached = providerFetch("OIDC discovery", `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`).then(
      async (response) => {
        if (!response.ok) {
          const message = `OIDC discovery failed with ${response.status}`;
          throw response.status >= 500 ? new OidcUnavailable(message) : new OidcError(message);
        }
        return (await response.json()) as Discovery;
      },
    );
    cached.catch(() => discoveryCache.delete(issuer));
    discoveryCache.set(issuer, cached);
  }
  return cached;
}

export async function buildOidcAuthUrl(
  config: OidcClientConfig,
  options: { state: string; codeChallenge: string; scopes?: ReadonlyArray<string> },
): Promise<string> {
  const { authorization_endpoint } = await discover(config.issuer);
  const url = new URL(authorization_endpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  // offline_access: the conventional OIDC way to ask for a refresh token.
  url.searchParams.set("scope", (options.scopes ?? ["openid", "email", "profile", "offline_access"]).join(" "));
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function tokenRequest(config: OidcClientConfig, params: Record<string, string>) {
  const discovery = await discover(config.issuer);
  const response = await providerFetch("Token request", discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...params, client_id: config.clientId, client_secret: config.clientSecret }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  return { discovery, response, body };
}

export interface OidcSignIn {
  claims: IdTokenClaims;
  /** Present when the client is allowed the refresh_token grant. */
  refreshToken?: string;
  /** The raw ID token: a JWT the provider signed for this client, for services that verify it themselves. */
  idToken: string;
  /** Names (never values) of the fields in the token response, for diagnostics. */
  responseFields: Array<string>;
}

/** Exchanges the code; returns the verified ID token claims and the refresh token. */
export async function exchangeOidcCode(config: OidcClientConfig, code: string, codeVerifier: string): Promise<OidcSignIn> {
  const { discovery, response, body } = await tokenRequest(config, {
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: config.redirectUri,
  });
  if (!response.ok || !body.id_token) {
    // Access's own description stays in the error line, never in what the person reads.
    throw new (response.status >= 500 ? OidcUnavailable : OidcError)(
      `Token exchange failed (${response.status}): ${body.error ?? "no id_token"}${body.error_description ? ` – ${body.error_description}` : ""}`,
    );
  }
  const claims = await verifyIdToken(body.id_token, {
    issuer: discovery.issuer,
    audience: config.clientId,
    jwksUri: discovery.jwks_uri,
  });
  return { claims, refreshToken: body.refresh_token, idToken: body.id_token, responseFields: Object.keys(body) };
}

/**
 * Uses a refresh token. With Cloudflare Access this re-evaluates the Access policies for the
 * user, so a successful refresh means the user is still allowed in. Throws OidcRefreshDenied when
 * the provider refuses (4xx other than invalid_client), OidcError when it is unreachable, failing
 * or refusing our client (retryable for the person; ours to fix).
 */
export async function refreshOidcToken(
  config: OidcClientConfig,
  refreshToken: string,
): Promise<{ refreshToken?: string; idToken?: string }> {
  let result;
  try {
    result = await tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken });
  } catch (error) {
    throw new OidcError(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const { response, body } = result;
  if (response.ok) return { refreshToken: body.refresh_token, idToken: body.id_token };
  const message = `Refresh refused (${response.status}): ${body.error ?? "unknown"}`;
  // invalid_client is our client secret: ending every session for it would be wrong.
  const denied = response.status >= 400 && response.status < 500 && body.error !== "invalid_client";
  throw denied ? new OidcRefreshDenied(message) : new OidcError(message);
}

/** When an ID token expires (epoch ms), read without verifying: for one the provider just issued to us. */
export function idTokenExpiry(idToken: string): number | undefined {
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(base64UrlDecode(idToken.split(".")[1] ?? ""))) as { exp?: unknown };
    return typeof exp === "number" ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// ID token verification

/** Keys per isolate, by JWKS URL and kid; an unknown kid reloads the set (key rotation). */
const keyCache = new Map<string, CryptoKey>();

/** Only for tests. */
export function resetOidcState(): void {
  keyCache.clear();
  discoveryCache.clear();
}

async function signingKey(jwksUri: string, kid: string): Promise<CryptoKey> {
  const cacheKey = `${jwksUri}#${kid}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const response = await providerFetch("JWKS fetch", jwksUri);
  if (!response.ok) throw new (response.status >= 500 ? OidcUnavailable : OidcError)(`JWKS fetch failed with ${response.status}`);
  const { keys } = (await response.json()) as { keys: Array<JsonWebKey & { kid?: string }> };
  for (const jwk of keys) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    keyCache.set(`${jwksUri}#${jwk.kid}`, key);
  }
  const key = keyCache.get(cacheKey);
  if (!key) throw new OidcError(`No signing key with kid ${kid}`);
  return key;
}

export async function verifyIdToken(
  token: string,
  expected: { issuer: string; audience: string; jwksUri: string; clockSkewSeconds?: number },
): Promise<IdTokenClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new OidcError("Malformed ID token");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const decode = (part: string) => {
    try {
      return JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
    } catch {
      throw new OidcError("Malformed ID token");
    }
  };

  const header = decode(headerPart) as { alg?: string; kid?: string };
  if (header.alg !== "RS256" || !header.kid) throw new OidcError(`Unsupported ID token header (alg ${header.alg})`);

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    await signingKey(expected.jwksUri, header.kid),
    base64UrlDecode(signaturePart),
    encoder.encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new OidcError("ID token signature is invalid");

  const claims = decode(payloadPart) as IdTokenClaims;
  const now = Math.floor(Date.now() / 1000);
  const skew = expected.clockSkewSeconds ?? 60;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== expected.issuer) throw new OidcError("ID token issuer mismatch");
  if (!audiences.includes(expected.audience)) throw new OidcError("ID token audience mismatch");
  if (typeof claims.exp !== "number" || claims.exp + skew < now) throw new OidcError("ID token expired");
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) throw new OidcError("ID token not yet valid");
  return claims;
}
