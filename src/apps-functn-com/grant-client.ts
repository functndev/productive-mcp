/*
 * apps.functn.com grant client. grant-client v2.1.
 *
 * Copied verbatim into every functn app whose access is managed on
 * apps.functn.com. The source is functndev/functn-apps
 * src/access/client/grant-client.ts; change it there, bump the version above,
 * and copy it to the apps listed in that repo's README. Do not edit a copy.
 * No dependencies: WebCrypto only. The design is in that repo's
 * docs/authorization.md.
 *
 * Wiring, in the app's cloudflare.config.ts:
 *
 *   ACCESS: bindings.worker({
 *     worker: 'apps-functn-com',
 *     exportName: 'Access',
 *     props: { caller: '<this worker's name>' }, // with an `app` in apps' callers.ts
 *   }),
 *   // The JWKS grants are signed with (apps.functn.com README; also served at
 *   // https://apps.functn.com/.well-known/jwks.json).
 *   GRANT_PUBLIC_KEYS: bindings.text<string>('{"keys":[…]}'),
 *
 * A grant is an OAuth 2.0 access token in the JWT profile (RFC 9068), signed
 * by apps.functn.com with Ed25519 (RFC 8037) for 10 minutes. The app gets it
 * by token exchange (RFC 8693) of the person's Cloudflare Access JWT, verifies
 * it locally, keeps it in a cookie (browser apps) or the OAuth grant props
 * (MCP servers) and renews it before it runs out, so most requests need no
 * call. While apps.functn.com cannot be reached a grant stays usable for 15
 * minutes past its expiry, then the app denies. A refusal always wins over a
 * cached grant.
 *
 * v2: sends the request's CF-Ray as `request_id`, which apps.functn.com puts
 * on its `access.grant` line as `requestId`; a failed call reads "apps.functn.com
 * is not working right now" instead of the binding's error text. Same RPC
 * surface and codes as v1.
 */

export const GRANT_ISSUER = 'https://apps.functn.com'
/** Prefix of our own (collision-resistant) claim names. */
export const CLAIM_NS = 'https://apps.functn.com/'

/** RFC 9068 access token claims, with OIDC person claims and RFC 9068/SCIM authorization attributes. */
export type GrantClaims = {
  iss: 'https://apps.functn.com'
  /** Email, lowercase. */
  sub: string
  /** App id, e.g. 'docs'. */
  aud: string
  /** The app the token was issued to: the same app id. */
  client_id: string
  iat: number
  /** iat + 600. */
  exp: number
  jti: string
  email: string
  given_name: string
  family_name: string
  name: string
  /** Effective roles in `aud`, never empty. Map them to permissions in the app. */
  roles: Array<string>
  /** Group ids, informational only. */
  groups: Array<string>
  /** The apps the person may open (app switcher), as `app:<id>`. */
  entitlements: Array<string>
  /** Catalog version; refetch the catalog when newer. */
  'https://apps.functn.com/catalog': number
  'https://apps.functn.com/personio_id': string | null
}

export const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt'
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'
export const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'

/** An RFC 8693 token exchange request (the form fields of a token request). */
export type TokenExchangeRequest = {
  grant_type: typeof TOKEN_EXCHANGE
  /** The person's Cloudflare Access (or Access for SaaS) JWT. Never an email. */
  subject_token: string
  subject_token_type: typeof SUBJECT_TOKEN_TYPE
  /** The app id. */
  audience: string
  requested_token_type?: typeof ACCESS_TOKEN_TYPE
  /** The caller's request id (its CF-Ray), for apps.functn.com's log line. */
  request_id?: string
}

/** RFC 8693 §2.2.1 response, plus the claims for convenience. */
export type TokenResponse = {
  access_token: string
  issued_token_type: typeof ACCESS_TOKEN_TYPE
  token_type: 'Bearer'
  expires_in: number
  claims: GrantClaims
}

/**
 * RFC 6749 §5.2 error codes (plus `access_denied` and
 * `temporarily_unavailable`): `access_denied` means not for this person (say
 * so and link to `appsUrl`), `invalid_grant` a bad Access token,
 * `invalid_target` / `invalid_client` / `invalid_request` /
 * `unsupported_grant_type` a caller bug,
 * `temporarily_unavailable` apps.functn.com unreachable without a usable grant.
 */
export type TokenError = {
  error:
    | 'invalid_request'
    | 'invalid_client'
    | 'invalid_grant'
    | 'unsupported_grant_type'
    | 'invalid_target'
    | 'access_denied'
    | 'temporarily_unavailable'
  error_description: string
  appsUrl: string
}

export type CatalogApp = {
  id: string
  name: string
  short?: string
  description: string
  url: string
  icon: { viewBox: string; body: string }
  /**
   * The app's MCP server, if it has one (v2.1; copies on v2 ignore it).
   * Shown on apps.functn.com, for people to connect Claude to it.
   */
  mcp?: { url: string }
  /** Empty: the app is not managed here (Cloudflare Access alone decides). */
  roles: Array<{ id: string; label: string; description: string }>
}

export type Catalog = { version: number; apps: Array<CatalogApp> }

export type PublicJwk = JsonWebKey & { kid?: string }

/** The grant part of the RPC surface of apps-functn-com's `Access` entrypoint. */
export interface GrantApi {
  grant: (request: TokenExchangeRequest) => Promise<TokenResponse | TokenError>
  catalog: (
    sinceVersion?: number,
  ) => Promise<Catalog | { unchanged: true; version: number }>
  jwks: () => Promise<{ keys: Array<PublicJwk> }>
}

export const isTokenError = (
  answer: TokenResponse | TokenError,
): answer is TokenError => 'error' in answer

/** The token exchange request for a person's Access JWT and this app. */
export const exchangeRequest = (
  accessJwt: string,
  app: string,
  requestId?: string,
): TokenExchangeRequest => ({
  grant_type: TOKEN_EXCHANGE,
  subject_token: accessJwt,
  subject_token_type: SUBJECT_TOKEN_TYPE,
  audience: app,
  requested_token_type: ACCESS_TOKEN_TYPE,
  ...(requestId ? { request_id: requestId } : {}),
})

export const GRANT_COOKIE = '__Host-functn-grant'
/** Renew in the background when less than this is left. */
export const RENEW_BEFORE_S = 2 * 60
/** How long past `exp` a grant stays usable while apps.functn.com is unreachable. */
export const GRACE_S = 15 * 60
/** At most one `jwks()` call per isolate this often, for unknown key ids. */
const JWKS_REFETCH_S = 5 * 60
/** A catalog without a newer version in a grant is asked again after this. */
const CATALOG_FRESH_S = 10 * 60

const nowS = () => Math.floor(Date.now() / 1000)

// ---------------------------------------------------------------------------
// Verifying

export type Verified =
  | {
      ok: true
      token: string
      claims: GrantClaims
      /** fresh: use; renew: use and renew; grace: past exp, only while apps.functn.com is down. */
      state: 'fresh' | 'renew' | 'grace'
    }
  | {
      ok: false
      reason:
        | 'malformed'
        | 'unknown_key'
        | 'bad_signature'
        | 'wrong_issuer'
        | 'wrong_audience'
        | 'wrong_subject'
        | 'expired'
    }

function base64urlBytes(part: string): Uint8Array<ArrayBuffer> {
  const base64 = part.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

const decodeJson = (part: string): unknown =>
  JSON.parse(new TextDecoder().decode(base64urlBytes(part)))

const parseKeys = (keys: string | { keys: Array<PublicJwk> }) =>
  (typeof keys === 'string'
    ? (JSON.parse(keys || '{"keys":[]}') as { keys?: Array<PublicJwk> })
    : keys
  ).keys ?? []

// Imported keys, by kid and key material. Module scope: once per isolate.
const importedKeys = new Map<string, Promise<CryptoKey | null>>()

function importKey(jwk: PublicJwk): Promise<CryptoKey | null> {
  const id = `${jwk.kid}|${jwk.x}`
  let key = importedKeys.get(id)
  if (!key) {
    key = crypto.subtle
      .importKey(
        'jwk',
        { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
        { name: 'Ed25519' },
        false,
        ['verify'],
      )
      .catch(() => null)
    importedKeys.set(id, key)
  }
  return key
}

/**
 * Checks a grant (RFC 9068 with WebCrypto): header `alg` EdDSA and `typ`
 * at+jwt, the Ed25519 signature (`kid` from `publicKeys`), issuer, audience
 * and client_id (this app), subject (the email the app verified from the
 * person's Access token) and lifetime.
 */
export async function verifyGrant(
  token: string,
  expected: {
    app: string
    email: string
    publicKeys: string | { keys: Array<PublicJwk> }
    /** Asked when the grant names a key id `publicKeys` lacks. */
    moreKeys?: () => Promise<Array<PublicJwk>>
    now?: number
  },
): Promise<Verified> {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  let header: { alg?: unknown; kid?: unknown; typ?: unknown } | null
  // Untrusted until checked below.
  let claims: { [K in keyof GrantClaims]?: unknown } | null
  let signature: Uint8Array<ArrayBuffer>
  try {
    header = decodeJson(parts[0]) as typeof header
    claims = decodeJson(parts[1]) as typeof claims
    signature = base64urlBytes(parts[2])
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (
    !header ||
    header.alg !== 'EdDSA' ||
    header.typ !== 'at+jwt' ||
    typeof header.kid !== 'string' ||
    !claims ||
    typeof claims.exp !== 'number' ||
    typeof claims.iat !== 'number' ||
    typeof claims.jti !== 'string' ||
    !Array.isArray(claims.roles)
  ) {
    return { ok: false, reason: 'malformed' }
  }

  let jwk = parseKeys(expected.publicKeys).find((k) => k.kid === header.kid)
  if (!jwk && expected.moreKeys) {
    jwk = (await expected.moreKeys()).find((k) => k.kid === header.kid)
  }
  const key = jwk && (await importKey(jwk))
  if (!key) return { ok: false, reason: 'unknown_key' }
  const valid = await crypto.subtle.verify(
    'Ed25519',
    key,
    signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  )
  if (!valid) return { ok: false, reason: 'bad_signature' }

  if (claims.iss !== GRANT_ISSUER) return { ok: false, reason: 'wrong_issuer' }
  if (claims.aud !== expected.app || claims.client_id !== expected.app) {
    return { ok: false, reason: 'wrong_audience' }
  }
  if (claims.sub !== expected.email.trim().toLowerCase()) {
    return { ok: false, reason: 'wrong_subject' }
  }
  const left = claims.exp - (expected.now ?? nowS())
  if (left <= -GRACE_S) return { ok: false, reason: 'expired' }
  const state = left > RENEW_BEFORE_S ? 'fresh' : left > 0 ? 'renew' : 'grace'
  return { ok: true, token, claims: claims as GrantClaims, state }
}

// ---------------------------------------------------------------------------
// Cookie

/** `Set-Cookie` for a grant: lives until its grace period ends. */
export function grantCookie(token: string, exp: number, now = nowS()) {
  const maxAge = Math.max(0, exp + GRACE_S - now)
  return `${GRANT_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
}

export const clearGrantCookie = () =>
  `${GRANT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`

export function grantFromCookie(request: Request): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const pair of header.split(';')) {
    const at = pair.indexOf('=')
    if (at > 0 && pair.slice(0, at).trim() === GRANT_COOKIE) {
      return pair.slice(at + 1).trim() || null
    }
  }
  return null
}

/** The Access JWT of a request that came through Cloudflare Access. */
export function accessJwtFrom(request: Request): string | null {
  return request.headers.get('cf-access-jwt-assertion')
}

// ---------------------------------------------------------------------------
// The client

export type GrantClientOptions = {
  /** The `Access` service binding. */
  binding: unknown
  /** This app's id in the catalog, e.g. 'docs'. */
  app: string
  /** GRANT_PUBLIC_KEYS: a JWKS (text or parsed). */
  publicKeys: string | { keys: Array<PublicJwk> }
  /** Where `temporarily_unavailable` and client-side refusals link to. */
  appsUrl?: string
  /** Cache API cache for the catalog; default `caches.default` where it exists. */
  cache?: Cache | null
}

export type Granted = { ok: true; token: string; claims: GrantClaims }
export type Refused = { ok: false } & TokenError

export type RequestResult = (Granted | Refused) & { setCookie?: string }

type Held = { token: string; claims: GrantClaims }

// Module scope: one per isolate, however often grantClient() is called.
const held = new Map<string, Held>()
/** Refused at this time (s): grants issued before it are ignored here. */
const refusedAt = new Map<string, number>()
const renewing = new Map<string, Promise<Granted | Refused>>()
let fetchedKeys: { keys: Array<PublicJwk>; at: number } | null = null
let catalogMemory: { catalog: Catalog; at: number } | null = null
const HELD_MAX = 2000

/** Only for tests: forget everything this isolate holds. */
export function resetGrantClientState() {
  held.clear()
  refusedAt.clear()
  renewing.clear()
  importedKeys.clear()
  fetchedKeys = null
  catalogMemory = null
}

export function grantClient(options: GrantClientOptions) {
  const api = options.binding as GrantApi
  const appsUrl = options.appsUrl ?? GRANT_ISSUER
  const refused = (
    error: TokenError['error'],
    description: string,
  ): Refused => ({ ok: false, error, error_description: description, appsUrl })
  const keyOf = (email: string) =>
    `${options.app}|${email.trim().toLowerCase()}`

  const moreKeys = async () => {
    if (!fetchedKeys || nowS() - fetchedKeys.at > JWKS_REFETCH_S) {
      try {
        fetchedKeys = { keys: (await api.jwks()).keys, at: nowS() }
      } catch {
        return fetchedKeys?.keys ?? []
      }
    }
    return fetchedKeys.keys
  }

  const verify = (token: string, email: string) =>
    verifyGrant(token, {
      app: options.app,
      email,
      publicKeys: options.publicKeys,
      moreKeys,
    })

  /** A verified grant this isolate may still use (not refused since it was issued). */
  const usable = async (token: string | null | undefined, email: string) => {
    if (!token) return null
    const result = await verify(token, email)
    if (!result.ok) return null
    const refusal = refusedAt.get(keyOf(email))
    if (refusal !== undefined && result.claims.iat <= refusal) return null
    return result
  }

  /** Token exchange with apps.functn.com; one call per person at a time. */
  const exchange = (
    accessJwt: string,
    email: string,
    requestId?: string,
  ): Promise<Granted | Refused> => {
    const key = keyOf(email)
    const running = renewing.get(key)
    if (running) return running
    const call = (async (): Promise<Granted | Refused> => {
      let answer: TokenResponse | TokenError
      try {
        answer = await api.grant(
          exchangeRequest(accessJwt, options.app, requestId),
        )
      } catch {
        // The binding's error text is not for the person.
        return refused(
          'temporarily_unavailable',
          'apps.functn.com is not working right now; try again in a minute',
        )
      }
      if (isTokenError(answer)) {
        if (answer.error !== 'temporarily_unavailable') {
          held.delete(key)
          refusedAt.set(key, nowS())
        }
        return { ok: false, ...answer }
      }
      // Never trust a token unchecked, even from the binding.
      const checked = await verify(answer.access_token, email)
      if (!checked.ok) {
        return refused(
          'invalid_grant',
          `apps.functn.com sent a grant this app does not accept (${checked.reason})`,
        )
      }
      refusedAt.delete(key)
      if (held.size >= HELD_MAX) {
        const oldest = held.keys().next().value
        if (oldest !== undefined) held.delete(oldest)
      }
      held.set(key, { token: answer.access_token, claims: checked.claims })
      return { ok: true, token: answer.access_token, claims: checked.claims }
    })().finally(() => renewing.delete(key))
    renewing.set(key, call)
    return call
  }

  return {
    /**
     * The person's grant for a browser request. `email` is the address the
     * app has already verified from this request's Access JWT. Append
     * `setCookie` to the response when present.
     */
    async forRequest(
      request: Request,
      context: {
        email: string
        waitUntil: (promise: Promise<unknown>) => void
        /** Default: the request's Cf-Access-Jwt-Assertion. */
        accessJwt?: string | null
      },
    ): Promise<RequestResult> {
      const email = context.email.trim().toLowerCase()
      const cookie = grantFromCookie(request)
      const memory = held.get(keyOf(email))?.token
      const candidates = await Promise.all([
        usable(memory, email),
        cookie === memory ? null : usable(cookie, email),
      ])
      const best = candidates
        .filter((c) => c !== null)
        .sort((a, b) => b.claims.exp - a.claims.exp)
        .at(0)
      const withCookie = (granted: Granted): RequestResult =>
        granted.token === cookie
          ? { ok: true, token: granted.token, claims: granted.claims }
          : {
              ok: true,
              token: granted.token,
              claims: granted.claims,
              setCookie: grantCookie(granted.token, granted.claims.exp),
            }

      const accessJwt = context.accessJwt ?? accessJwtFrom(request)
      const requestId = request.headers.get('cf-ray') ?? undefined
      if (best && best.state === 'fresh') return withCookie(best)
      if (best && best.state === 'renew') {
        if (accessJwt) context.waitUntil(exchange(accessJwt, email, requestId))
        return withCookie(best)
      }
      if (!accessJwt) {
        return {
          ...refused('invalid_grant', 'No Access token on this request'),
          ...(cookie ? { setCookie: clearGrantCookie() } : {}),
        }
      }
      const renewed = await exchange(accessJwt, email, requestId)
      if (renewed.ok) return withCookie(renewed)
      // Down: a grant in its grace period still counts. Refused: it does not.
      if (renewed.error === 'temporarily_unavailable' && best) {
        return withCookie(best)
      }
      return {
        ...renewed,
        ...(cookie ? { setCookie: clearGrantCookie() } : {}),
      }
    },

    /** Always asks apps.functn.com (and keeps the answer in this isolate). */
    /** `requestId`: the request's CF-Ray, for apps.functn.com's log line. */
    fresh: (accessJwt: string, email: string, requestId?: string) =>
      exchange(accessJwt, email, requestId),

    verify,

    /**
     * The app catalog, at least `minVersion` (a grant's
     * `https://apps.functn.com/catalog`). From memory, then the Cache API
     * (keyed by version), then apps.functn.com. Null only when it was never
     * reachable.
     */
    async catalog(minVersion?: number): Promise<Catalog | null> {
      const memory = catalogMemory
      if (memory) {
        const fresh =
          minVersion === undefined
            ? nowS() - memory.at < CATALOG_FRESH_S
            : memory.catalog.version >= minVersion
        if (fresh) return memory.catalog
      }
      const cache =
        options.cache !== undefined
          ? options.cache
          : ((globalThis as { caches?: { default?: Cache } }).caches?.default ??
            null)
      const cacheKey = (version: number) =>
        `https://grant-client.functn.internal/catalog/${version}`
      if (cache && minVersion !== undefined) {
        try {
          const hit = await cache.match(cacheKey(minVersion))
          if (hit) {
            const catalog = await hit.json<Catalog>()
            catalogMemory = { catalog, at: nowS() }
            return catalog
          }
        } catch {
          // The cache is only a shortcut.
        }
      }
      try {
        const answer = await api.catalog(memory?.catalog.version)
        if ('unchanged' in answer) {
          if (!memory) throw new Error('unchanged without a catalog')
          catalogMemory = { catalog: memory.catalog, at: nowS() }
          return memory.catalog
        }
        catalogMemory = { catalog: answer, at: nowS() }
        if (cache) {
          try {
            await cache.put(
              cacheKey(answer.version),
              new Response(JSON.stringify(answer), {
                headers: {
                  'content-type': 'application/json',
                  'cache-control': 'max-age=86400',
                },
              }),
            )
          } catch {
            // The cache is only a shortcut.
          }
        }
        return answer
      } catch {
        return memory?.catalog ?? null
      }
    },
  }
}

// ---------------------------------------------------------------------------
// MCP servers

/** What an MCP server keeps in its OAuth grant props, next to the Access token. */
export type GrantProps = { grant: string }

/**
 * For MCP servers that sign people in through Access for SaaS. The grant
 * lives in the OAuth grant props: `issue` at sign-in, `refresh` with every
 * MCP token refresh (with the fresh Access token), `verify` on tool calls.
 * Keep the MCP access token's TTL at 10 minutes or less, so a refresh always
 * comes before the grant's grace period ends.
 */
export function mcpGrant(options: GrantClientOptions) {
  const client = grantClient(options)
  const appsUrl = options.appsUrl ?? GRANT_ISSUER

  return {
    /** At sign-in: the props to store, or why this person may not use the app. */
    async issue(
      accessJwt: string,
      email: string,
      requestId?: string,
    ): Promise<{ ok: true; props: GrantProps; claims: GrantClaims } | Refused> {
      const answer = await client.fresh(accessJwt, email, requestId)
      if (!answer.ok) return answer
      return { ok: true, props: { grant: answer.token }, claims: answer.claims }
    },

    /**
     * On every MCP token refresh. Refused: end the session (do not issue a
     * new MCP token). Unreachable: keeps the old grant while it is in grace.
     */
    async refresh(
      accessJwt: string,
      email: string,
      previous: Partial<GrantProps> | undefined,
      requestId?: string,
    ): Promise<{ ok: true; props: GrantProps; claims: GrantClaims } | Refused> {
      const answer = await client.fresh(accessJwt, email, requestId)
      if (answer.ok) {
        return {
          ok: true,
          props: { grant: answer.token },
          claims: answer.claims,
        }
      }
      if (answer.error === 'temporarily_unavailable' && previous?.grant) {
        const old = await client.verify(previous.grant, email)
        if (old.ok) {
          return { ok: true, props: { grant: old.token }, claims: old.claims }
        }
      }
      return answer
    },

    /** On a tool call: the grant in the props, if still usable. */
    async verify(
      props: Partial<GrantProps> | undefined,
      email: string,
    ): Promise<{ ok: true; claims: GrantClaims } | Refused> {
      const result = props?.grant
        ? await client.verify(props.grant, email)
        : null
      if (result?.ok) return { ok: true, claims: result.claims }
      return {
        ok: false,
        error: 'invalid_grant',
        error_description: `No valid grant for this session (${result ? result.reason : 'none'}): sign in again`,
        appsUrl,
      }
    },

    catalog: client.catalog,
  }
}
