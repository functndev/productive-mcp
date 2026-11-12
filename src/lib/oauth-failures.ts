// Copied from functndev/functn-it v0.11.3 (dbe463f): logging/oauth-failures.ts. Do not edit here; change it there and copy it over.
// How a Worker built on `@cloudflare/workers-oauth-provider` answers a
// failure: functndev/functn-it, errors/README.md. Needs `http-error.ts` and
// `log.ts` next to it.
//
// The OAuth provider library answers OAuth's own errors itself, but rethrows
// everything else (a KV or D1 outage, a failed token exchange with Access, a
// bug), and Cloudflare then shows its HTML error page: OAuth clients get HTML
// instead of JSON, and Claude's "connect" dialog hangs. This top-level catch
// logs the failure once (`request.failed`, unless a `unit()` already did) and
// answers in each caller's format, by path:
// - `/token`, `/register`: `{"error": "server_error", "error_description"}`
//   (`temporarily_unavailable` for a 503), as JSON;
// - `/mcp` (and `/sse`): a JSON-RPC error;
// - `/authorize` and the sign-in callbacks: once the handler has validated the
//   client's redirect URI and called `redirectFailuresTo`, a redirect back to
//   the client with `error=server_error`; before that, a page;
// - anything else: a page for a browser, the JSON envelope otherwise.
//
//   const provider = new OAuthProvider({ … })
//   export default { fetch: withOAuthFailures((r, env, ctx) => provider.fetch(r, env, ctx)) }
//
//   // in /authorize, once parseAuthRequest and lookupClient accepted it:
//   redirectFailuresTo(oauthReq.redirectUri, oauthReq.state)
//   // in a callback, once the stored request is read back:
//   redirectFailuresTo(stored.redirectUri, stored.state)
//
// Needs `nodejs_compat`, or `nodejs_als`, as `log.ts` does.

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  HttpError,
  errorPage,
  errorResponse,
  requestIdOf,
  wantsPage,
} from './http-error'
import { log, wasLogged } from './log'

export type OAuthPaths = {
  /** OAuth's token and registration endpoints: JSON errors. */
  token: ReadonlyArray<string>
  /** The MCP endpoints: JSON-RPC errors. */
  api: ReadonlyArray<string>
}

const DEFAULT_PATHS: OAuthPaths = {
  token: ['/token', '/register', '/oauth/token', '/oauth/register'],
  api: ['/mcp', '/sse'],
}

type Redirect = { redirectUri: string; state?: string }

const redirects = new AsyncLocalStorage<{ to?: Redirect }>()

/**
 * Call once the client's redirect URI is validated (the client is known and
 * registered that URI). A failure after this point redirects the browser back
 * to the client with `error=server_error`, as RFC 6749 4.1.2.1 asks, instead
 * of stranding the person on a page.
 */
export function redirectFailuresTo(redirectUri: string, state?: string): void {
  const store = redirects.getStore()
  if (store)
    store.to = { redirectUri, ...(state === undefined ? {} : { state }) }
}

const matches = (paths: ReadonlyArray<string>, path: string) =>
  paths.some((p) => path === p || path.startsWith(`${p}/`))

function answerOf(error: unknown, requestId?: string): HttpError {
  if (error instanceof HttpError) {
    if (error.requestId === undefined && requestId) error.requestId = requestId
    return error
  }
  return new HttpError(500, 'Something went wrong on our side. Try again.', {
    code: 'internal_error',
    ...(requestId ? { requestId } : {}),
  })
}

/** CORS for the JSON answers, as the library gives its own. */
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin')
  return origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Expose-Headers': 'cf-ray, Retry-After',
        Vary: 'Origin',
      }
    : {}
}

/** OAuth's error code for an answer (RFC 6749 4.1.2.1 and 5.2). */
function oauthCode(answer: HttpError): string {
  if (answer.status === 503) return 'temporarily_unavailable'
  if (answer.status >= 500) return 'server_error'
  if (answer.code === 'access_denied' || answer.code === 'forbidden') {
    return 'access_denied'
  }
  return 'invalid_request'
}

function oauthError(answer: HttpError, request: Request): Response {
  return Response.json(
    { error: oauthCode(answer), error_description: answer.message },
    {
      status: answer.status,
      headers: { 'Cache-Control': 'no-store', ...corsHeaders(request) },
    },
  )
}

function jsonRpcError(answer: HttpError, request: Request): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      // The JSON-RPC request's id went with the body the handler read.
      id: null,
      error: {
        // JSON-RPC's internal error, or invalid request for a refusal.
        code: answer.status >= 500 ? -32603 : -32600,
        message: answer.message,
        data: {
          code: answer.code,
          ...(answer.requestId ? { requestId: answer.requestId } : {}),
        },
      },
    },
    { status: answer.status, headers: corsHeaders(request) },
  )
}

function redirectBack(to: Redirect, answer: HttpError): Response {
  const url = new URL(to.redirectUri)
  url.searchParams.set('error', oauthCode(answer))
  url.searchParams.set('error_description', answer.message)
  if (to.state !== undefined) url.searchParams.set('state', to.state)
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), 'Cache-Control': 'no-store' },
  })
}

/**
 * Wraps the Worker's fetch: the OAuth provider's, or whatever routes to it.
 * `paths` replaces the defaults per kind.
 */
export function withOAuthFailures<Env, Ctx>(
  fetch: (request: Request, env: Env, ctx: Ctx) => Response | Promise<Response>,
  paths: Partial<OAuthPaths> = {},
): (request: Request, env: Env, ctx: Ctx) => Promise<Response> {
  const known: OAuthPaths = { ...DEFAULT_PATHS, ...paths }
  return (request, env, ctx) => {
    const store: { to?: Redirect } = {}
    return redirects.run(store, async () => {
      try {
        return await fetch(request, env, ctx)
      } catch (error) {
        const requestId = requestIdOf(request)
        const answer = answerOf(error, requestId)
        if (answer.status >= 500 && !wasLogged(error)) {
          log.error('request.failed', { error })
        }
        const path = new URL(request.url).pathname
        if (matches(known.token, path)) return oauthError(answer, request)
        if (matches(known.api, path)) return jsonRpcError(answer, request)
        if (store.to) return redirectBack(store.to, answer)
        return wantsPage(request) ? errorPage(answer) : errorResponse(answer)
      }
    })
  }
}
