// Copied from functndev/functn-it v0.11.3 (dbe463f): logging/http-error.ts. Do not edit here; change it there and copy it over.
// An answer to a failed request: functndev/functn-it, errors/README.md.
//
// The error an app throws to answer its caller with a status and a code, and
// the shapes that answer travels in: Start's serialized error (with the
// serialization adapter below), the JSON envelope for plain HTTP APIs, and a
// plain page for a person. No dependencies and nothing Node.js: a TanStack
// Start app imports it on the client too, which is why it is not a `.server`
// file.

import type { ToolError } from './log'

/**
 * Stable snake_case codes a client may branch on. An app adds its own where a
 * client needs to tell a case apart (`deal_taken`), and keeps them stable:
 * the code is a contract, the message is not.
 */
export type ErrorCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'forbidden'
  | 'access_denied'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'rate_limited'
  | 'internal_error'
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'unavailable'
  | 'not_configured'
  | (string & {})

export type HttpErrorOptions = {
  /** What the client branches on. Defaults to the status's code (below). */
  code?: ErrorCode
  /** Why, for the log line (logging/README.md): a short snake_case code. */
  reason?: string
  /** The request's CF-Ray. The recipes fill it in when it is missing. */
  requestId?: string
  /** What a client needs beyond the code (`updatedBy`, `connectUrl`). */
  details?: Record<string, unknown>
  cause?: unknown
}

const CODE_OF_STATUS: Record<number, ErrorCode> = {
  400: 'invalid_input',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  422: 'invalid_input',
  429: 'rate_limited',
  500: 'internal_error',
  502: 'upstream_unavailable',
  503: 'unavailable',
  504: 'upstream_timeout',
}

/** The code a status stands for when the thrower named none. */
export function codeOfStatus(status: number): ErrorCode {
  return (
    CODE_OF_STATUS[status] ??
    (status >= 500 ? 'internal_error' : 'invalid_input')
  )
}

/**
 * An answer for the caller. A 4xx is a refusal: its message is for the person
 * or client and says what to do. A 5xx is our trouble: its message never
 * carries internals (no upstream text, no SQL, no stack).
 */
export class HttpError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly reason?: string
  requestId?: string
  readonly details?: Record<string, unknown>

  constructor(status: number, message: string, options: HttpErrorOptions = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = 'HttpError'
    this.status = status
    this.code = options.code ?? codeOfStatus(status)
    if (options.reason !== undefined) this.reason = options.reason
    if (options.requestId !== undefined) this.requestId = options.requestId
    if (options.details !== undefined) this.details = options.details
  }
}

/** What an `HttpError` turns into on the wire; also its constructor's input. */
export type HttpErrorWire = {
  status: number
  message: string
  code: ErrorCode
  reason?: string
  requestId?: string
  details?: Record<string, unknown>
}

function toWire(error: HttpError): HttpErrorWire {
  return {
    status: error.status,
    message: error.message,
    code: error.code,
    ...(error.reason === undefined ? {} : { reason: error.reason }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    ...(error.details === undefined ? {} : { details: error.details }),
  }
}

/**
 * For TanStack Start, whose own serializer keeps only an error's `message`.
 * Register it in `src/start.ts`, so the client gets an `HttpError` with
 * status, code, reason and requestId:
 *
 *   serializationAdapters: [createSerializationAdapter(httpErrorAdapter)]
 *
 * (`createSerializationAdapter` from '@tanstack/react-router').
 */
export const httpErrorAdapter = {
  key: 'functn/HttpError',
  test: (value: unknown): value is HttpError => value instanceof HttpError,
  toSerializable: (error: HttpError): HttpErrorWire => toWire(error),
  fromSerializable: (wire: HttpErrorWire): HttpError =>
    new HttpError(wire.status, wire.message, wire),
}

/** The JSON envelope plain HTTP APIs answer with (errors/README.md). */
export type ErrorBody = {
  error: {
    code: ErrorCode
    message: string
    requestId?: string
    details?: Record<string, unknown>
  }
}

export function errorBody(error: HttpError): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  }
}

/** The envelope as a response, with the error's status. */
export function errorResponse(
  error: HttpError,
  init?: { headers?: HeadersInit },
): Response {
  const headers = new Headers(init?.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(errorBody(error)), {
    status: error.status,
    headers,
  })
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] ?? c,
  )

/**
 * A plain page for a person, in place of Cloudflare's: what happened and what
 * to do next. An app with its own error page in its shell uses that instead.
 */
export function errorPage(
  error: HttpError,
  options?: { title?: string },
): Response {
  const title =
    options?.title ??
    (error.status >= 500 ? 'Something went wrong' : 'This did not work')
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1.5rem;color:#111}@media(prefers-color-scheme:dark){body{background:#050505;color:#eee}}h1{font-size:1.25rem}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(error.message)}</p>
</body>
</html>`
  return new Response(html, {
    status: error.status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

/** The request's CF-Ray, which every log line of the request carries as `requestId`. */
export function requestIdOf(request: Request): string | undefined {
  return request.headers.get('cf-ray') ?? undefined
}

/** True for a TanStack Start server-function call (Start's client sets the header). */
export function isServerFnRequest(request: Request): boolean {
  return request.headers.get('x-tsr-serverfn') === 'true'
}

/** True for a person's browser navigating to a page, not a script calling an API. */
export function wantsPage(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  if (isServerFnRequest(request)) return false
  return (request.headers.get('accept') ?? '').includes('text/html')
}

const TOOL_ERROR_OF_CODE: Record<string, ToolError> = {
  invalid_input: 'invalid_input',
  too_large: 'invalid_input',
  not_found: 'not_found',
  unauthenticated: 'forbidden',
  forbidden: 'forbidden',
  access_denied: 'forbidden',
  conflict: 'conflict',
  upstream_unavailable: 'upstream',
  upstream_timeout: 'upstream',
  unavailable: 'upstream',
  rate_limited: 'rate_limited',
  not_configured: 'not_configured',
}

/**
 * The MCP tool error kind an `HttpError`'s code maps to, or undefined when
 * none fits: then it is no tool error but a failure (errors/README.md,
 * "Codes, reasons and tool errors").
 */
export function toolErrorOf(code: ErrorCode): ToolError | undefined {
  return TOOL_ERROR_OF_CODE[code]
}
