// Copied from functndev/functn-it v0.9.1 (090b8b9): logging/log.ts. Do not edit here; change it there and copy it over.
// The logging convention in code: functndev/functn-it, logging/README.md.
// Needs `nodejs_compat`, or `nodejs_als` on an old compatibility date
// (AsyncLocalStorage). No dependencies.

import { AsyncLocalStorage } from 'node:async_hooks'

export type LogFields = Record<string, unknown>
export type LogLevel = 'info' | 'warn' | 'error'
export type UnitResult = 'ok' | 'skipped' | 'partial' | 'failed'

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
  const line: LogFields = { event }
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
   * A failed attempt the queue will retry: throws `error` again, and the
   * summary goes out `failed` at `warn` with `willRetry: true`, `attempt` and
   * `maxAttempts`. On the last attempt (`attempt >= maxAttempts`, the one that
   * goes to the dead-letter queue) it is a normal failure at `error`.
   * `attempt` is 1-based, as `message.attempts`.
   */
  retry: (
    error: unknown,
    attempts: { attempt: number; maxAttempts: number },
  ) => never
  /**
   * Counts one call to an upstream API on the summary line: `<api>Calls`,
   * `<api>Ms` and `<api>Failed` (e.g. `productiveCalls`, `gaMs`).
   */
  count: (api: string, call: { ms: number; failed?: boolean }) => void
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
 * A throw is logged as a `failed` summary at `error` and rethrown, so the
 * failure reaches the Worker's handler and Cloudflare records it. A failure
 * the app handles does not throw: `u.fail(error)`. A queue attempt that will
 * be retried: `u.retry(error, { attempt, maxAttempts })`.
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
    retry: (error, { attempt, maxAttempts }) => {
      retrying = { attempt, maxAttempts }
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

// Query parameters whose values never reach a log line; the tail consumer
// (functndev/monitoring.functn.com, workers/logging-functn-com) keeps the same
// list.
const SECRET_QUERY_PARAM =
  /^(code|token|access_token|id_token|refresh_token|key|api_key|apikey|secret|client_secret|password|signature|sig|jwt|auth|x-amz-.*)$/i

/** The URL with the values of secret query parameters replaced. */
export function redactUrl(url: string): string {
  const query = url.indexOf('?')
  if (query === -1) return url
  const hash = url.indexOf('#', query)
  const end = hash === -1 ? url.length : hash
  const params = url
    .slice(query + 1, end)
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
      return SECRET_QUERY_PARAM.test(name)
        ? `${pair.slice(0, eq)}=[redacted]`
        : pair
    })
  return `${url.slice(0, query + 1)}${params.join('&')}${url.slice(end)}`
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
