// Copied from functndev/functn-it v0.11.3 (dbe463f): logging/log.ts. Do not edit here; change it there and copy it over.
// The logging convention in code: functndev/functn-it, logging/README.md.
// Needs `nodejs_compat`, or `nodejs_als` on an old compatibility date
// (AsyncLocalStorage). No dependencies.

import { AsyncLocalStorage } from 'node:async_hooks'

export type LogLevel = 'info' | 'warn' | 'error'
export type UnitResult = 'ok' | 'skipped' | 'partial' | 'failed'

/** What an MCP tool error is, from the model's side (logging/README.md, "MCP tool calls"). */
export type ToolError =
  | 'invalid_input'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'upstream'
  | 'rate_limited'
  | 'not_configured'

/**
 * Who acted: an Access email, `<provider>:<id>` for an identity outside Access
 * (`github:chrillo`, `productive:12345`, `service:<client id>` for an Access
 * service token), or `system:<worker>` for automation.
 */
export type Actor = `${string}@${string}` | `${string}:${string}`

/** Fields the convention gives a meaning; checked by the type where it can. */
export type KnownFields = {
  actor?: Actor
  result?: UnitResult
  /** Why a unit refused or skipped: a short snake_case code (`rate_limited`). */
  reason?: string
  /** Only on refusals and skips that answered a 4xx. */
  statusCode?: number
  toolError?: ToolError
  toolMessage?: string
  dataLost?: boolean
}

export type LogFields = KnownFields & Record<string, unknown>

/** `{name, message, stack, cause}` of a thrown value, ready for a log line. */
export type LoggedError = {
  name: string
  message: string
  stack?: string
  cause?: LoggedError
}

const MAX_STRING = 500
const MAX_STACK = 4000
const MAX_DEPTH = 4
const MAX_FAILURES_LOGGED = 10

// Field names that are Loki labels: `| json` would rename them to
// `<name>_extracted`. `level` comes from the console method instead.
const RESERVED = new Set([
  'app',
  'level',
  'outcome',
  'event_type',
  'method',
  'service_name',
])

// A safety net, not a licence: secrets should never reach a log call. Matches
// keys ending in these words (`accessToken`, `clientSecret`), not counts like
// `inputTokens` or `tokenCount`.
const SECRET_KEY =
  /(password|passwd|secret|token|authori[sz]ation|cookie|api[-_]?key|signature)$/i

const context = new AsyncLocalStorage<LogFields>()
const currentUnit = new AsyncLocalStorage<Unit>()

// Errors already written as the failure's one `error` line (or a unit's
// `failed` summary), so the recipes that answer a failure don't write a second.
const loggedErrors = new WeakSet<object>()

function markLogged(value: unknown): void {
  if (typeof value === 'object' && value !== null) loggedErrors.add(value)
}

/**
 * True when this error was already logged: by `unit()` (its `failed` summary),
 * by `log.error(event, { error })`, or by a file that can't import this one
 * and sets `logged: true` on the error (`access.ts`). The recipes that answer
 * a failure check it, so each failure leaves one `error` line.
 */
export function wasLogged(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (
    loggedErrors.has(error) || (error as { logged?: unknown }).logged === true
  )
}

/**
 * Marks an answer whose failure already has its one `error` line, and returns
 * it. For an error built from a failure a unit or `log.error` logged (a 502 or
 * 503 `HttpError` made in the catch around a failed unit, an answer built from
 * `access.ts`'s logged `AccessError`): `unit()` marks the error it caught, not
 * the new one, so the recipe answering it would write a second line.
 */
export function alreadyLogged<T extends object>(answer: T): T {
  markLogged(answer)
  return answer
}

/**
 * Runs `fn` with `fields` (ids, actor) added to every line written inside it,
 * on top of the fields of any context it runs in.
 */
export function withLogContext<T>(fields: LogFields, fn: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, fn)
}

/** Adds fields to the current context, e.g. the actor once auth has run. */
export function addLogContext(fields: LogFields): void {
  const store = context.getStore()
  if (store) Object.assign(store, fields)
}

export function serializeError(value: unknown, depth = 0): LoggedError {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncate(value.message, MAX_STRING),
      ...(value.stack ? { stack: truncate(value.stack, MAX_STACK) } : {}),
      ...(value.cause !== undefined && depth < MAX_DEPTH
        ? { cause: serializeError(value.cause, depth + 1) }
        : {}),
    }
  }
  // A plain message string, as many APIs pass errors around.
  if (typeof value === 'string') {
    return { name: 'Error', message: truncate(value, MAX_STRING) }
  }
  return { name: 'NonError', message: truncate(stringify(value), MAX_STRING) }
}

/** Builds the line without writing it. Exported for tests. */
export function buildLine(event: string, fields?: LogFields): string {
  const line: Record<string, unknown> = { event }
  for (const [key, value] of Object.entries({
    ...context.getStore(),
    ...fields,
  })) {
    if (value === undefined || key === 'event') continue
    line[RESERVED.has(key) ? `${key}_` : key] = clean(key, value, 0)
  }
  return JSON.stringify(line)
}

function write(level: LogLevel, event: string, fields?: LogFields): void {
  const line = buildLine(event, fields)
  if (level === 'error') markLogged(fields?.error)
  // One string argument: the tail consumer makes one Loki line per argument.
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}

export const log = {
  /** A unit that went fine, or an audit event. Prefer `unit()` for units. */
  info: (event: string, fields?: LogFields) => write('info', event, fields),
  /** Something went wrong and was handled. */
  warn: (event: string, fields?: LogFields) => write('warn', event, fields),
  /** A person should look. Pass the thrown value as `error`. */
  error: (event: string, fields?: LogFields) => write('error', event, fields),
}

export type Unit = {
  /** Adds fields to the summary line: counts, ids found on the way. `result` and `durationMs` are the unit's own and win. */
  set: (fields: LogFields) => void
  /** Marks the unit `skipped` or `partial`; a throw makes it `failed` (and is rethrown). */
  result: (result: Exclude<UnitResult, 'ok' | 'failed'>) => void
  /**
   * One line per failed item, up to 10 per unit; the rest are counted. The
   * unit becomes `partial`. The line is a `warn`, or an `error` with
   * `{ dataLost: true }` when the lost item leaves data wrong.
   */
  itemFailed: (
    event: string,
    fields?: LogFields,
    options?: { dataLost?: boolean },
  ) => void
  /**
   * Marks the unit `failed` without throwing, e.g. a check that returned an
   * error. The summary goes out at `error` with `error` set.
   */
  fail: (error: unknown) => void
  /**
   * A failed attempt the platform will retry: throws `error` again, and the
   * summary goes out `failed` at `warn` with `willRetry: true`, `attempt` and
   * `maxAttempts`. On the last attempt (`attempt >= maxAttempts`: the queue
   * message goes to the dead-letter queue, the alarm is given up) it is a
   * normal failure at `error`.
   *
   * - A queue message: `{ attempt: message.attempts, maxAttempts }` (1-based).
   * - A Durable Object alarm: the `alarmInfo` Cloudflare passes to `alarm()`,
   *   `{ retryCount }` (0 on the first run, 6 retries at most):
   *   `u.retry(error, { retryCount: alarmInfo?.retryCount ?? 0 })`.
   */
  retry: (error: unknown, attempts: RetryAttempts) => never
  /**
   * Counts one call to an upstream API on the summary line: `<api>Calls`,
   * `<api>Ms` and `<api>Failed` (e.g. `productiveCalls`, `gaMs`). `ms` is the
   * whole call, the body read included (a stream: until it is set up).
   */
  count: (api: string, call: { ms: number; failed?: boolean }) => void
}

/** Which attempt failed: a queue message's, or an alarm's retry count. */
export type RetryAttempts =
  { attempt: number; maxAttempts: number } | { retryCount: number }

/** Cloudflare runs a throwing alarm again up to 6 times: 7 attempts in all. */
export const ALARM_MAX_ATTEMPTS = 7

function attemptsOf(attempts: RetryAttempts): {
  attempt: number
  maxAttempts: number
} {
  if ('retryCount' in attempts) {
    return {
      attempt: attempts.retryCount + 1,
      maxAttempts: ALARM_MAX_ATTEMPTS,
    }
  }
  return { attempt: attempts.attempt, maxAttempts: attempts.maxAttempts }
}

/**
 * The innermost unit the code runs in, for code deep in the call stack that
 * adds to the summary line without being handed `u`:
 * `getUnit()?.set({ statusCode })`.
 */
export function getUnit(): Unit | undefined {
  return currentUnit.getStore()
}

/**
 * Runs one unit of work (a probe run, a queue message, a sync job, an MCP tool
 * call, a webhook) and writes its summary line: `event`, `result`,
 * `durationMs`, the context's ids and whatever `set()` added. `fields` also
 * become context for every line inside the unit. Returns `fn`'s value.
 *
 * A throw is logged as a `failed` summary at `error` and rethrown, marked as
 * logged (`wasLogged`), so whatever answers the caller (errors/README.md)
 * doesn't log it again. A failure the app handles does not throw:
 * `u.fail(error)`. A queue or alarm attempt that will be retried:
 * `u.retry(error, attempts)`.
 */
export async function unit<T>(
  event: string,
  fields: LogFields,
  fn: (unit: Unit) => Promise<T> | T,
): Promise<T> {
  const started = Date.now()
  const summary: LogFields = {}
  let result: UnitResult = 'ok'
  let failedItems = 0
  let failure: { error: unknown } | undefined
  let retrying: { attempt: number; maxAttempts: number } | undefined
  const calls: Record<string, number> = {}

  const handle: Unit = {
    set: (more) => Object.assign(summary, more),
    result: (marked) => {
      result = marked
    },
    itemFailed: (itemEvent, itemFields, options) => {
      failedItems += 1
      if (failedItems > MAX_FAILURES_LOGGED) return
      if (options?.dataLost) log.error(itemEvent, itemFields)
      else log.warn(itemEvent, itemFields)
    },
    fail: (error) => {
      failure = { error }
    },
    retry: (error, attempts) => {
      retrying = attemptsOf(attempts)
      // Kept in case the code inside the unit catches the throw again.
      failure = { error }
      throw error
    },
    count: (api, { ms, failed }) => {
      calls[`${api}Calls`] = (calls[`${api}Calls`] ?? 0) + 1
      calls[`${api}Ms`] = (calls[`${api}Ms`] ?? 0) + ms
      calls[`${api}Failed`] = (calls[`${api}Failed`] ?? 0) + (failed ? 1 : 0)
    },
  }

  const failed = (error: unknown) => {
    markLogged(error)
    const willRetry =
      retrying !== undefined && retrying.attempt < retrying.maxAttempts
    write(willRetry ? 'warn' : 'error', event, {
      ...summary,
      ...calls,
      result: 'failed',
      ...(willRetry ? { willRetry } : {}),
      ...retrying,
      durationMs: Date.now() - started,
      ...counts(failedItems),
      error: serializeError(error),
    })
  }

  return withLogContext(fields, () =>
    currentUnit.run(handle, async () => {
      let value: T
      try {
        value = await fn(handle)
      } catch (error) {
        failed(error)
        throw error
      }
      // u.fail(), or a u.retry() whose throw was caught inside the unit
      if (failure) {
        failed(failure.error)
        return value
      }
      if (failedItems > 0 && result === 'ok') result = 'partial'
      write(result === 'partial' ? 'warn' : 'info', event, {
        ...summary,
        ...calls,
        result,
        durationMs: Date.now() - started,
        ...counts(failedItems),
      })
      return value
    }),
  )
}

// What a logged URL must not show (logging/README.md, "Never logged"). The
// one source: the tail consumer (functndev/monitoring.functn.com,
// workers/logging-functn-com) copies these lists from here.

const REDACTED = '[redacted]'

// Query parameters whose values never reach a log line.
const SECRET_QUERY_PARAM =
  /^(code|token|access_token|id_token|refresh_token|key|api_key|apikey|secret|client_secret|password|signature|sig|jwt|auth|x-amz-.*)$/i

/**
 * Paths that carry a secret in a segment. `path` is matched against the start
 * of the URL's path, segment by segment: a literal must match exactly, `:name`
 * matches any one segment, and `:secret` matches any one segment and is
 * replaced with `[redacted]`. Whatever follows the matched prefix is kept.
 */
export const SECRET_PATHS: ReadonlyArray<{ host: string; path: string }> = [
  // Feedback's public share links: /share/<taskId>/<token>, and the files
  // under them (/share/<taskId>/<token>/files/<attachmentId>).
  { host: 'feedback.functn.com', path: '/share/:taskId/:secret' },
]

/** Query parameters on one exact path that are named like a secret but aren't. */
export const PUBLIC_QUERY_PARAMS: ReadonlyArray<{
  host: string
  path: string
  params: ReadonlyArray<string>
}> = [
  // Feedback's image proxy takes the project's public id (it is in every
  // client site's widget snippet) as `token`.
  {
    host: 'feedback.functn.com',
    path: '/public/api/proxy-image',
    params: ['token'],
  },
]

// scheme://authority, then the path; a relative URL is all path.
const URL_PARTS = /^((?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*))?([^?#]*)/i

function hostOf(authority: string): string {
  const host = authority.slice(authority.lastIndexOf('@') + 1)
  return host.replace(/:\d+$/, '').toLowerCase()
}

function redactPath(host: string, path: string): string {
  const segments = path.split('/')
  for (const rule of SECRET_PATHS) {
    if (rule.host !== host) continue
    const template = rule.path.split('/')
    if (segments.length < template.length) continue
    const matches = template.every(
      (part, i) => part.startsWith(':') || part === segments[i],
    )
    if (!matches) continue
    template.forEach((part, i) => {
      if (part === ':secret' && segments[i] !== '') segments[i] = REDACTED
    })
  }
  return segments.join('/')
}

function publicParams(host: string, path: string): ReadonlySet<string> {
  const names = PUBLIC_QUERY_PARAMS.filter(
    (rule) => rule.host === host && rule.path === path,
  ).flatMap((rule) => rule.params)
  return new Set(names.map((name) => name.toLowerCase()))
}

function redactQuery(query: string, keep: ReadonlySet<string>): string {
  return query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq === -1) return pair
      let name = pair.slice(0, eq)
      try {
        name = decodeURIComponent(name)
      } catch {
        // keep it as written
      }
      if (keep.has(name.toLowerCase()) || !SECRET_QUERY_PARAM.test(name)) {
        return pair
      }
      return `${pair.slice(0, eq)}=${REDACTED}`
    })
    .join('&')
}

/**
 * The URL with its query string, secrets replaced with `[redacted]`: the
 * values of secret query parameters, and the path segments `SECRET_PATHS`
 * names. The query often explains why a request did or didn't work, so
 * everything else stays.
 */
export function redactUrl(url: string): string {
  const parts = URL_PARTS.exec(url)
  const origin = parts?.[1] ?? ''
  const host = parts?.[2] === undefined ? '' : hostOf(parts[2])
  const path = parts?.[3] ?? ''
  let rest = url.slice(origin.length + path.length)

  const redactedPath = redactPath(host, path)
  if (rest.startsWith('?')) {
    const hash = rest.indexOf('#')
    const end = hash === -1 ? rest.length : hash
    rest = `?${redactQuery(rest.slice(1, end), publicParams(host, path))}${rest.slice(end)}`
  }
  return `${origin}${redactedPath}${rest}`
}

const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/
const EMAIL_ACTOR = /^[^\s@:]+@[^\s@:]+$/
const PROVIDER_ACTOR = /^[a-z][a-z0-9_-]*:\S+$/
const RESULTS: ReadonlyArray<unknown> = ['ok', 'skipped', 'partial', 'failed']
const TOOL_ERRORS: ReadonlyArray<unknown> = [
  'invalid_input',
  'not_found',
  'forbidden',
  'conflict',
  'upstream',
  'rate_limited',
  'not_configured',
]
const LEVEL_OF_RESULT: Record<string, LogLevel> = {
  ok: 'info',
  skipped: 'info',
  partial: 'warn',
}
const MAX_LINE = 2048
const MAX_LINE_WITH_STACK = 8192
const MAX_IDS = 10

/**
 * The rules the type can't check, for an app's tests: hand it a line the app
 * wrote (and the console method that wrote it) and it returns what breaks the
 * convention, or nothing. For example, with the console spied on:
 * `expect(checkLine(spy.mock.calls[0][0], 'info')).toEqual([])`.
 */
export function checkLine(line: string, level?: LogLevel): Array<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return ['not one JSON object']
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return ['not one JSON object']
  }
  const fields = parsed as Record<string, unknown>
  const problems: Array<string> = []
  const { event, result, reason, statusCode, toolError, actor, error } = fields

  if (typeof event !== 'string' || !EVENT_NAME.test(event)) {
    problems.push(`event ${JSON.stringify(event)} is not <area>.<action>`)
  }
  for (const key of Object.keys(fields)) {
    if (RESERVED.has(key)) problems.push(`${key} is a Loki label`)
    if (key === 'status') {
      problems.push(
        "status: our answer is statusCode, an upstream's is <api>Status",
      )
    }
    const value = fields[key]
    if (key.endsWith('Ids') && Array.isArray(value) && value.length > MAX_IDS) {
      problems.push(`${key} lists more than ${MAX_IDS} ids; count them`)
    }
  }
  if (result !== undefined && !RESULTS.includes(result)) {
    problems.push(`result ${JSON.stringify(result)} is not a unit result`)
  }
  if (
    reason !== undefined &&
    (typeof reason !== 'string' || !SNAKE_CASE.test(reason))
  ) {
    problems.push(`reason ${JSON.stringify(reason)} is not a snake_case code`)
  }
  if (
    statusCode !== undefined &&
    (typeof statusCode !== 'number' || statusCode < 400 || statusCode > 499)
  ) {
    problems.push('statusCode belongs on 4xx refusals only')
  }
  if (toolError !== undefined && !TOOL_ERRORS.includes(toolError)) {
    problems.push(
      `toolError ${JSON.stringify(toolError)} is not one of the 7 kinds`,
    )
  }
  if (
    actor !== undefined &&
    (typeof actor !== 'string' ||
      !(EMAIL_ACTOR.test(actor) || PROVIDER_ACTOR.test(actor)))
  ) {
    problems.push(
      `actor ${JSON.stringify(actor)} is not an email or <provider>:<id>`,
    )
  }
  if (level !== undefined) {
    if (typeof result === 'string') {
      const expected = LEVEL_OF_RESULT[result]
      if (expected && expected !== level) {
        problems.push(
          `result ${result} is written at ${expected}, not ${level}`,
        )
      }
      if (result === 'failed' && level === 'info') {
        problems.push('result failed is written at warn or error')
      }
    }
    if (level === 'info' && error !== undefined) {
      problems.push('an info line carries no error')
    }
  }
  const max = line.includes('"stack"') ? MAX_LINE_WITH_STACK : MAX_LINE
  if (line.length > max) problems.push(`longer than ${max} characters`)
  return problems
}

function counts(failedItems: number): LogFields {
  return failedItems > 0 ? { failedItems } : {}
}

function clean(key: string, value: unknown, depth: number): unknown {
  if (SECRET_KEY.test(key)) return '[redacted]'
  if (typeof value === 'string')
    return truncate(value, key === 'stack' ? MAX_STACK : MAX_STRING)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) return serializeError(value)
  if (value instanceof Date) return value.toISOString()
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[too deep]'
  if (Array.isArray(value))
    return value.slice(0, 20).map((item) => clean('', item, depth + 1))
  const out: LogFields = {}
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = clean(k, v, depth + 1)
  }
  return out
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    // undefined for functions and symbols, whatever the type says
    const json = JSON.stringify(value) as string | undefined
    return json ?? String(value)
  } catch {
    return String(value)
  }
}
