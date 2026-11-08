// Signed attachment downloads: Productive's answers mapped to statuses curl can act on, each
// download one attachment.download line.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createAttachmentLinkSigner, handleAttachmentDownload } from './attachment-links.js';
import { checkLine } from './lib/log.js';

const env = {
  COOKIE_ENCRYPTION_KEY: 'test-cookie-key',
  PRODUCTIVE_ORG_ID: '1',
  PRODUCTIVE_API_BASE_URL: 'https://api.productive.io/api/v2/',
  USER_MAPPING: JSON.stringify({ 'me@functn.com': { userId: 123, apiToken: 'token' } }),
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

async function download(link?: string) {
  const url = link ?? (await createAttachmentLinkSigner('https://productive-mcp.functn.com', env.COOKIE_ENCRYPTION_KEY, '123').create('5', 'a.pdf')).url;
  return handleAttachmentDownload(new Request(url), env);
}

describe('attachment downloads', () => {
  test('streams the file and logs one ok line', async () => {
    productive(() => Response.json(attachment));
    const response = await download();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('pdf');
    expect(downloadLine()).toMatchObject({ level: 'info', result: 'ok', attachmentId: '5', actor: 'productive:123', productiveCalls: 2 });
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

  test("a rejected Productive token is ours: 503 not_configured at error", async () => {
    productive(() => new Response('', { status: 401 }));
    const response = await download();
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_configured');
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

  test('a tampered link is a 403 refusal', async () => {
    const { url } = await createAttachmentLinkSigner('https://x', env.COOKIE_ENCRYPTION_KEY, '123').create('5', 'a.pdf');
    const response = await download(url.replace('/5/', '/6/'));
    expect(response.status).toBe(403);
    expect(downloadLine()).toMatchObject({ level: 'info', result: 'skipped', reason: 'bad_signature' });
  });

  test('an unreadable USER_MAPPING is a 503 with one error line, not a 1101', async () => {
    const { url } = await createAttachmentLinkSigner('https://x', env.COOKIE_ENCRYPTION_KEY, '123').create('5', 'a.pdf');
    const response = await handleAttachmentDownload(new Request(url), { ...env, USER_MAPPING: '{' } as unknown as Env);
    expect(response.status).toBe(503);
    expect(downloadLine()).toMatchObject({ level: 'error', result: 'failed' });
  });
});
