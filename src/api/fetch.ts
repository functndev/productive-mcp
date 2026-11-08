// Every request to Productive goes through productiveFetch, so the unit it runs in (an mcp.tool
// call, an attachment download) can say on its summary line how many calls it made, how long they
// took (`u.count`: productiveCalls, productiveMs, productiveFailed) and what it changed. A failed
// answer is one warn line; a call is never a line of its own.

import { getUnit, log, type Unit } from '../lib/log.js';

/** A non-2xx answer from Productive. The message is what the model sees, as before. */
export class ProductiveApiError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or 0 when the request got no answer. */
    readonly status: number,
  ) {
    super(message);
    this.name = 'ProductiveApiError';
    // Kept for the unit's toolMessage: tools wrap this message in their own text, which can quote
    // what was written.
    const unit = getUnit();
    if (unit) notesOf(unit).lastFailedMessage = message;
  }
}

/** What a unit's Productive calls left besides their counts, which `u.count` keeps. */
type Notes = {
  /** Failed calls so far, for the cap on warn lines. */
  failures: number;
  /** Status of the last failed call; 0 when the request itself failed (network). */
  lastFailedStatus?: number;
  /** Productive's own message for that failure. */
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

/**
 * fetch() for Productive. Counts the call on the current unit and writes one warn line for a
 * failed answer (`productive.rate_limited` for a 429). Never logs the URL's query (the attachment
 * host takes the token there) or any header.
 */
export async function productiveFetch(url: string, init?: RequestInit): Promise<Response> {
  const unit = getUnit();
  const method = init?.method ?? 'GET';
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const n = countCall(unit, started, 0);
    if (!n || n.failures <= MAX_FAILURES_LOGGED) {
      log.warn('productive.request_failed', { httpMethod: method, path: pathOf(url), error });
    }
    // Same message as before, so the model sees no difference; status 0 marks "no answer".
    throw Object.assign(new ProductiveApiError(error instanceof Error ? error.message : String(error), 0), { cause: error });
  }
  const n = countCall(unit, started, response.ok ? undefined : response.status);
  if (!response.ok && (!n || n.failures <= MAX_FAILURES_LOGGED)) {
    const fields = { httpMethod: method, path: pathOf(url), status: response.status };
    if (response.status === 429) {
      log.warn('productive.rate_limited', { ...fields, retryAfter: response.headers.get('retry-after') ?? undefined });
    } else {
      log.warn('productive.request_failed', fields);
    }
  }
  return response;
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
