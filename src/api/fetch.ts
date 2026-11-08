// Every request to Productive goes through productiveFetch, so the unit it runs in (an mcp.tool
// call, an attachment download) can say on its summary line how many calls it made, how long they
// took (`u.count`: productiveCalls, productiveMs, productiveFailed) and what it changed. A failed
// answer is one warn line; a call is never a line of its own.

import { getUnit, log, type Unit } from '../lib/log.js';
import type { ProductiveError } from './types.js';

/**
 * How long a Productive call may take (functn-it stack/README.md, "Upstream calls"): a person or
 * a model waits for every one of them.
 */
export const PRODUCTIVE_TIMEOUT_MS = 15_000;

/** A failed Productive call. The message is what the model sees. */
export class ProductiveApiError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or 0 when the request got no answer. */
    readonly status: number,
    readonly options: {
      /** No answer within PRODUCTIVE_TIMEOUT_MS. */
      timedOut?: boolean;
      /** Productive's Retry-After for a 429, in seconds. */
      retryAfterS?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProductiveApiError';
    // Kept for the unit: tools wrap this message in their own text, which can quote what was
    // written. The status decides the call's kind, also for a failure found in a 2xx answer (the
    // attachment host's login page).
    const unit = getUnit();
    if (unit) {
      const n = notesOf(unit);
      n.lastFailedStatus = status;
      n.lastFailedMessage = message;
    }
  }
}

/** What a unit's Productive calls left besides their counts, which `u.count` keeps. */
type Notes = {
  /** Failed calls so far, for the cap on warn lines. */
  failures: number;
  /** Status of the last failed call; 0 when the request itself failed (network, timeout). */
  lastFailedStatus?: number;
  /** The message of that failure, as the model got it. */
  lastFailedMessage?: string;
  writes: string[];
};

const MAX_WRITES_LISTED = 10;
const MAX_FAILURES_LOGGED = 10;
const notes = new WeakMap<Unit, Notes>();

function notesOf(unit: Unit): Notes {
  let found = notes.get(unit);
  if (!found) notes.set(unit, (found = { failures: 0, writes: [] }));
  return found;
}

/** What the current unit's Productive calls left so far, or undefined outside a unit. */
export function productiveNotes(): Readonly<Notes> | undefined {
  const unit = getUnit();
  return unit && notes.get(unit);
}

/** Counts one call on the unit; a failed one also sets `productiveStatus`, the last failed status. */
function countCall(unit: Unit | undefined, started: number, failedStatus?: number): Notes | undefined {
  if (!unit) return undefined;
  const n = notesOf(unit);
  unit.count('productive', { ms: Date.now() - started, failed: failedStatus !== undefined });
  if (failedStatus !== undefined) {
    n.failures += 1;
    n.lastFailedStatus = failedStatus;
    unit.set({ productiveStatus: failedStatus });
  }
  return n;
}

/** The API path without host and query, e.g. `tasks/123`, for log lines. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/api\/v2\//, '');
  } catch {
    return url.split('?')[0] ?? url;
  }
}

const isTimeout = (error: unknown) => error instanceof Error && error.name === 'TimeoutError';

/**
 * The signal that ends a call after PRODUCTIVE_TIMEOUT_MS. `headers` only bounds the wait for the
 * answer's headers, for a body that is streamed on (an attachment file, which may take longer);
 * `done` must then be called once the headers are there.
 */
function timeoutSignal(scope: 'call' | 'headers'): { signal: AbortSignal; done: () => void } {
  if (scope === 'call') return { signal: AbortSignal.timeout(PRODUCTIVE_TIMEOUT_MS), done: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Productive did not answer in time', 'TimeoutError')),
    PRODUCTIVE_TIMEOUT_MS,
  );
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * fetch() for Productive. Counts the call on the current unit and writes one warn line for a
 * failed answer (`productive.rate_limited` for a 429). Never logs the URL's query (the attachment
 * host takes the token there) or any header. A call that gets no answer within
 * PRODUCTIVE_TIMEOUT_MS, or none at all, throws a ProductiveApiError with status 0.
 */
export async function productiveFetch(
  url: string,
  init?: RequestInit,
  options: { timeout?: 'call' | 'headers' } = {},
): Promise<Response> {
  const unit = getUnit();
  const method = init?.method ?? 'GET';
  const started = Date.now();
  const timeout = timeoutSignal(options.timeout ?? 'call');
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal,
    });
  } catch (error) {
    const n = countCall(unit, started, 0);
    const timedOut = isTimeout(error);
    if (!n || n.failures <= MAX_FAILURES_LOGGED) {
      log.warn('productive.request_failed', { httpMethod: method, path: pathOf(url), timedOut, error });
    }
    throw new ProductiveApiError(
      timedOut
        ? `Productive did not answer within ${PRODUCTIVE_TIMEOUT_MS / 1000} seconds. Try again shortly.`
        : 'Could not reach Productive. Try again shortly.',
      0,
      { timedOut, cause: error },
    );
  } finally {
    timeout.done();
  }
  const n = countCall(unit, started, response.ok ? undefined : response.status);
  if (!response.ok && (!n || n.failures <= MAX_FAILURES_LOGGED)) {
    const fields = { httpMethod: method, path: pathOf(url), productiveStatus: response.status };
    if (response.status === 429) {
      log.warn('productive.rate_limited', { ...fields, retryAfter: response.headers.get('retry-after') ?? undefined });
    } else {
      log.warn('productive.request_failed', fields);
    }
  }
  return response;
}

/** Productive's own explanation from a JSON:API error body, with the field it is about. */
async function detailOf(response: Response, firstOnly: boolean): Promise<string | undefined> {
  let body: ProductiveError;
  try {
    body = (await response.json()) as ProductiveError;
  } catch {
    return undefined;
  }
  const errors = (body.errors ?? []).slice(0, firstOnly ? 1 : undefined);
  if (errors.length === 0) return undefined;
  return errors
    .map((e) => {
      const field = e.source?.pointer
        ? ` [field: ${e.source.pointer}]`
        : e.source?.parameter
          ? ` [param: ${e.source.parameter}]`
          : '';
      return `${e.detail || e.title || 'Unknown error'}${field}`;
    })
    .join('; ');
}

/** Seconds from a Retry-After header in its seconds form; the date form is rare and ignored. */
function retryAfterSeconds(response: Response): number | undefined {
  const value = Number(response.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

/**
 * The error for a non-2xx Productive answer, with a message the model can act on: Productive's
 * own explanation for a 4xx, what to do for the statuses whose explanation would mislead it (a
 * rejected token, a rate limit, Productive's own trouble).
 */
export async function productiveFailure(
  response: Response,
  options: { firstDetailOnly?: boolean } = {},
): Promise<ProductiveApiError> {
  const status = response.status;
  if (status === 401) {
    await response.body?.cancel();
    return new ProductiveApiError(
      'Productive rejected the API token this server uses for you (401). Someone at functn has to replace it; trying again will not help.',
      status,
    );
  }
  if (status === 429) {
    await response.body?.cancel();
    const retryAfterS = retryAfterSeconds(response);
    return new ProductiveApiError(
      `Productive's rate limit was reached. Try again in ${retryAfterS === undefined ? 'a minute' : `${retryAfterS} seconds`}.`,
      status,
      { retryAfterS },
    );
  }
  if (status >= 500) {
    await response.body?.cancel();
    return new ProductiveApiError(`Productive is having trouble (status ${status}). Try again shortly.`, status);
  }
  const detail = await detailOf(response, options.firstDetailOnly ?? false);
  return new ProductiveApiError(detail ?? `API request failed with status ${status}`, status);
}

/**
 * Notes a change Productive accepted, for the unit's `writes` field (`PATCH tasks/123`,
 * `POST tasks/456` with the new record's id). A delete is also an audit line.
 */
export function recordWrite(method: string, url: string, created?: { type?: string; id?: string }): void {
  const path = pathOf(url);
  const entry = method === 'POST' && created?.type && created.id ? `POST ${created.type}/${created.id}` : `${method} ${path}`;
  const unit = getUnit();
  if (unit) {
    const n = notesOf(unit);
    if (n.writes.length < MAX_WRITES_LISTED) n.writes.push(entry);
    unit.set({ writes: n.writes });
  }
  if (method === 'DELETE') {
    const [resource, resourceId] = path.split('/');
    log.info('audit.productive.delete', { resource, resourceId });
  }
}
