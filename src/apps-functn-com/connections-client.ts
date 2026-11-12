/*
 * apps.functn.com Connections client. connections-client v2.
 *
 * Copied verbatim into every functn Worker that calls third-party APIs as the
 * signed-in person through apps.functn.com. The source is
 * functndev/functn-apps src/connections/client/connections-client.ts; change
 * it there, bump the version above, and copy it to the callers listed in that
 * repo's README. Do not edit a copy. No dependencies.
 *
 * Wiring, in the caller's cloudflare.config.ts:
 *
 *   CONNECTIONS: bindings.worker({
 *     worker: 'apps-functn-com',
 *     exportName: 'Connections',
 *     props: { caller: '<this worker's name>' }, // must be in apps' callers.ts
 *   }),
 *
 * Every call carries the person's own Cloudflare Access token, which
 * apps.functn.com verifies itself. You cannot name a user:
 * - Browser apps behind Access: the request's `Cf-Access-Jwt-Assertion`
 *   (`userAuthFrom(request)`).
 * - MCP servers signing people in with Access for SaaS: the person's OIDC
 *   access token (`{ accessToken }`), kept fresh with the refresh token.
 *
 * Results are returned, not thrown: Workers RPC would turn custom errors into
 * plain ones. Provider responses (any status, 429 and 5xx included) come back
 * unchanged as `{ ok: true, response }`: handle limits and retries yourself.
 *
 * Pass your request id (`requestIdFrom(request)`, the CF-Ray) as the last
 * argument: apps.functn.com puts it on its log line as `requestId`.
 *
 * v2: `unavailable` (apps.functn.com itself failed; answer 503 and try again
 * later, never send the person to connect), the optional `CallContext`
 * argument, and `productive()` folds a thrown call into `unavailable`.
 */

export type ProviderId = 'productive'

/** The person's own Access token. Never an email. */
export type UserAuth = { accessToken: string }

export type ProviderRequest = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /**
   * Relative to the provider's API base ("deals/123?include=company" for
   * https://api.productive.io/api/v2/), or absolute on one of its hosts
   * (attachment files on https://files.productive.io/…).
   */
  path: string
  /** Credential headers (X-Auth-Token, Authorization …) are dropped. */
  headers?: Record<string, string>
  body?: string | ArrayBuffer | ReadableStream | null
}

export type ProviderError =
  /** The Access token is missing, invalid, expired or for another app. */
  | { ok: false; error: 'unauthenticated'; message: string }
  /** This caller may not make this call (apps' callers.ts): a bug in the caller. */
  | { ok: false; error: 'not_allowed'; message: string }
  /** The person has to (re)connect their account: send them to `connectUrl`. */
  | {
      ok: false
      error: 'not_connected' | 'token_invalid'
      message: string
      connectUrl: string
    }
  /** A failure dressed as success, e.g. the files host's login page. */
  | { ok: false; error: 'forbidden_by_provider'; message: string }
  /** The provider could not be reached at all (network error). */
  | { ok: false; error: 'provider_unavailable'; message: string }
  /**
   * apps.functn.com itself failed (its database, Access's keys, a bug): not a
   * refusal, nothing for the person to fix. Answer 503; `message` is a plain
   * sentence fit to show.
   */
  | { ok: false; error: 'unavailable'; message: string }

export type ProviderResult = { ok: true; response: Response } | ProviderError

export type ConnectionStatus =
  | {
      ok: true
      state: 'connected' | 'not_connected' | 'token_invalid'
      /** The provider's person behind the token, when connected. */
      account?: { id: string; name: string; email: string }
      /** Where the person connects or replaces the token. */
      connectUrl: string
    }
  | Extract<
      ProviderError,
      { error: 'unauthenticated' | 'not_allowed' | 'unavailable' }
    >

/** Optional, on every call that acts for a person. */
export type CallContext = {
  /** The caller's request id (its CF-Ray), for apps.functn.com's log line. */
  requestId?: string
}

/** The RPC surface of apps-functn-com's `Connections` entrypoint. */
export interface ConnectionsApi {
  request: (
    auth: UserAuth,
    provider: ProviderId,
    req: ProviderRequest,
    context?: CallContext,
  ) => Promise<ProviderResult>
  /** With a system credential (e.g. "productive-bot"); still on behalf of `auth`, for the log. */
  requestAsSystem: (
    auth: UserAuth,
    credential: string,
    req: ProviderRequest,
    context?: CallContext,
  ) => Promise<ProviderResult>
  /** Whether the person is connected. Never calls the provider. */
  status: (
    auth: UserAuth,
    provider: ProviderId,
    context?: CallContext,
  ) => Promise<ConnectionStatus>
  /** https://apps.functn.com/?provider=…&return=… */
  connectUrl: (provider: ProviderId, returnTo?: string) => Promise<string>
}

/** The binding, typed. Pass `env.CONNECTIONS`. */
export const connections = (binding: unknown) => binding as ConnectionsApi

/** The Access token of a request that came through Cloudflare Access. */
export function userAuthFrom(request: Request): UserAuth | null {
  const accessToken = request.headers.get('cf-access-jwt-assertion')
  return accessToken ? { accessToken } : null
}

/** The request's CF-Ray, to pass as `{ requestId }`. */
export function requestIdFrom(request: Request): string | undefined {
  return request.headers.get('cf-ray') ?? undefined
}

/**
 * Productive through apps.functn.com as the person. A thrown RPC error (the
 * binding failed, apps.functn.com is down) is folded into `unavailable`.
 *
 *   const p = productive(env.CONNECTIONS, auth, { requestId: requestIdFrom(request) })
 *   const result = await p.get('deals/123')
 *   if (!result.ok) return handle(result)
 *   const deal = await result.response.json()
 */
export function productive(
  binding: unknown,
  auth: UserAuth,
  context?: CallContext,
) {
  const api = connections(binding)
  const call = async (req: ProviderRequest): Promise<ProviderResult> => {
    try {
      return await api.request(auth, 'productive', req, context)
    } catch {
      // The binding's error text is not for the person.
      return {
        ok: false,
        error: 'unavailable',
        message:
          'apps.functn.com is not working right now; try again in a minute',
      }
    }
  }
  return {
    request: call,
    get: (path: string) => call({ method: 'GET', path }),
    post: (path: string, body: unknown) =>
      call({ method: 'POST', path, body: JSON.stringify(body) }),
    patch: (path: string, body: unknown) =>
      call({ method: 'PATCH', path, body: JSON.stringify(body) }),
    delete: (path: string) => call({ method: 'DELETE', path }),
    status: () => api.status(auth, 'productive', context),
  }
}
