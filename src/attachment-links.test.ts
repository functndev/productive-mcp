// Signed attachment downloads: Productive's answers mapped to statuses curl can act on, each
// download one attachment.download line.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createAttachmentLinkSigner, handleAttachmentDownload } from './attachment-links.js';
import { checkLine } from './lib/log.js';
import type { ProviderError, ProviderRequest } from './apps-functn-com/connections-client.js';

const BASE = 'https://api.productive.io/api/v2/';
const PERSON = { email: 'me@functn.com', idToken: 'id-token', idTokenExpiresAt: Date.now() + 60 * 60 * 1000 };

/** What the stand-in apps.functn.com Connections saw, and how it answers: through fetch, or refusing. */
const seen: Array<{ token: string; path: string }> = [];
let refusal: ProviderError | undefined;
const CONNECTIONS = {
  async request(auth: { accessToken: string }, _provider: string, req: ProviderRequest) {
    seen.push({ token: auth.accessToken, path: req.path });
    if (refusal) return refusal;
    const url = req.path.startsWith('https://') ? req.path : `${BASE}${req.path}`;
    return { ok: true, response: await fetch(url, { method: req.method }) };
  },
};

const env = {
  COOKIE_ENCRYPTION_KEY: 'test-cookie-key',
  PRODUCTIVE_API_BASE_URL: BASE,
  CONNECTIONS,
} as unknown as Env;

const attachment = {
  data: {
    id: '5',
    type: 'attachments',
    attributes: { name: 'a.pdf', content_type: 'application/pdf', size: 3, url: 'https://files.productive.io/a.pdf' },
  },
};

const realFetch = globalThis.fetch;
let spies: Array<ReturnType<typeof spyOn>>;
beforeEach(() => {
  seen.length = 0;
  refusal = undefined;
  spies = (['info', 'warn', 'error'] as const).map((level) => spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  spies.forEach((spy) => spy.mockRestore());
});

/** The attachment.download line and the console method that wrote it. */
function downloadLine(): Record<string, unknown> & { level: string } {
  for (const [i, spy] of spies.entries()) {
    for (const call of spy.mock.calls) {
      const line = JSON.parse(String(call[0]));
      if (line.event === 'attachment.download') {
        const level = ['info', 'warn', 'error'][i]!;
        expect(checkLine(String(call[0]), level as 'info')).toEqual([]);
        return { level, ...line };
      }
    }
  }
  throw new Error('no attachment.download line');
}

/** Productive answers the attachment lookup with `lookup` and the file with `file`. */
function productive(lookup: () => Response, file: () => Response = () => new Response('pdf')) {
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).startsWith('https://files.productive.io/') ? file() : lookup()) as unknown as typeof fetch;
}

const linkFor = async (person = PERSON, secret = env.COOKIE_ENCRYPTION_KEY) =>
  (await createAttachmentLinkSigner('https://productive-mcp.functn.com', secret, person).create('5', 'a.pdf')).url;

async function download(link?: string) {
  const url = link ?? (await linkFor());
  return handleAttachmentDownload(new Request(url), env);
}

describe('attachment downloads', () => {
  test('streams the file and logs one ok line', async () => {
    productive(() => Response.json(attachment));
    const response = await download();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('pdf');
    expect(downloadLine()).toMatchObject({ level: 'info', result: 'ok', attachmentId: '5', actor: 'me@functn.com', productiveCalls: 2 });
    // Both calls as the person, through Connections; the file by its absolute URL.
    expect(seen).toEqual([
      { token: 'id-token', path: 'attachments/5' },
      { token: 'id-token', path: 'https://files.productive.io/a.pdf' },
    ]);
  });

  test('the link shows neither the ID token nor the email', async () => {
    const url = await linkFor();
    expect(url).not.toContain('id-token');
    expect(url).not.toContain('functn.com/me');
    expect(decodeURIComponent(url)).not.toContain('me@functn.com');
  });

  test('a link never outlives the ID token in it', async () => {
    const soon = Date.now() + 2 * 60 * 1000;
    const { expiresAt } = await createAttachmentLinkSigner('https://x', env.COOKIE_ENCRYPTION_KEY, { ...PERSON, idTokenExpiresAt: soon }).create('5', 'a.pdf');
    expect(expiresAt.getTime()).toBeLessThanOrEqual(soon);
  });

  test('an expired link is a 410 refusal', async () => {
    const response = await download(await linkFor({ ...PERSON, idTokenExpiresAt: Date.now() - 1000 }));
    expect(response.status).toBe(410);
    expect(downloadLine()).toMatchObject({ level: 'info', result: 'skipped', statusCode: 410 });
    expect(seen).toEqual([]);
  });

  test.each([
    [404, 404, 'not_found'],
    [403, 403, 'forbidden'],
  ])('Productive %i is a %i refusal at info, not a 502', async (productiveStatus, status, code) => {
    productive(() => Response.json({ errors: [{ detail: 'Nope' }] }, { status: productiveStatus }));
    const response = await download();
    expect(response.status).toBe(status);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    expect(downloadLine()).toMatchObject({ level: 'info', result: 'skipped', statusCode: status });
  });

  test("Productive's 5xx is a 502 and fails the download at error", async () => {
    productive(() => new Response('down', { status: 503 }));
    const response = await download();
    expect(response.status).toBe(502);
    expect(downloadLine()).toMatchObject({ level: 'error', result: 'failed', productiveStatus: 503 });
  });

  test("a rejected Productive token is the person's: a 403 refusal", async () => {
    productive(() => new Response('', { status: 401 }));
    const response = await download();
    expect(response.status).toBe(403);
    expect(downloadLine()).toMatchObject({ level: 'info', result: 'skipped', statusCode: 403 });
  });

  test('no Productive account connected any more: a 403 refusal that says where to connect', async () => {
    refusal = { ok: false, error: 'not_connected', message: 'Productive is not connected.', connectUrl: 'https://apps.functn.com/?provider=productive' };
    const response = await download();
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).toContain('https://apps.functn.com/?provider=productive');
    expect(downloadLine()).toMatchObject({ level: 'info', result: 'skipped' });
  });

  test('apps.functn.com down is a 503 with one error line', async () => {
    refusal = { ok: false, error: 'unavailable', message: 'apps.functn.com is not working right now' };
    const response = await download();
    expect(response.status).toBe(503);
    expect(downloadLine()).toMatchObject({ level: 'error', result: 'failed' });
  });

  test('a rate limit passes Retry-After on', async () => {
    productive(() => new Response('', { status: 429, headers: { 'retry-after': '30' } }));
    const response = await download();
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
  });

  test("the file host's login page is a 403", async () => {
    productive(
      () => Response.json(attachment),
      () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    );
    expect((await download()).status).toBe(403);
    expect(downloadLine()).toMatchObject({ level: 'info', result: 'skipped', statusCode: 403 });
  });

  test.each([
    ['another attachment', (url: string) => url.replace('/5/', '/6/')],
    ['a changed link', (url: string) => url.replace(/l=(.)/, (_, c: string) => `l=${c === 'A' ? 'B' : 'A'}`)],
  ])('%s is a 403 refusal, and Productive is never called', async (_, change) => {
    const response = await download(change(await linkFor()));
    expect(response.status).toBe(403);
    expect(downloadLine()).toMatchObject({ level: 'info', result: 'skipped', reason: 'bad_link' });
    expect(seen).toEqual([]);
  });

  test('a link from before v2 (HMAC-signed) is a 400 refusal', async () => {
    const response = await download('https://x/attachments/5/a.pdf?u=123&exp=9999999999&sig=abc');
    expect(response.status).toBe(400);
    expect(downloadLine()).toMatchObject({ level: 'info', result: 'skipped', reason: 'malformed_link' });
  });

  test('a link made with another key is a 403 refusal', async () => {
    const response = await download(await linkFor(PERSON, 'another-key'));
    expect(response.status).toBe(403);
  });
});
