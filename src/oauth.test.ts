// The OAuth provider configuration (what clients discover) and the checks run on every refresh.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { OAuthError } from '@cloudflare/workers-oauth-provider';
import { recheckOnRefresh } from './access-handler.js';
import worker, { reportMcpError } from './index.js';
import { checkLine } from './lib/log.js';
import { createOAuthState, type Props } from './workers-oauth-utils.js';

/** Just enough of KVNamespace for the provider: metadata, registration, authorization. */
function memoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string, type?: unknown) => {
      const value = store.get(key);
      if (value === undefined) return null;
      const json = type === 'json' || (typeof type === 'object' && (type as { type?: string }).type === 'json');
      return json ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace;
}

const env = {
  OAUTH_KV: memoryKv(),
  PUBLIC_URL: 'https://productive-mcp.functn.com',
  PRODUCTIVE_API_BASE_URL: 'https://api.productive.io/api/v2/',
  ACCESS_CLIENT_ID: 'access-client',
  ACCESS_CLIENT_SECRET: 'access-secret',
  ACCESS_TOKEN_URL: 'https://functn.cloudflareaccess.com/cdn-cgi/access/sso/oidc/x/token',
  ACCESS_AUTHORIZATION_URL: 'https://functn.cloudflareaccess.com/cdn-cgi/access/sso/oidc/x/authorization',
  ACCESS_JWKS_URL: 'https://functn.cloudflareaccess.com/cdn-cgi/access/certs',
  COOKIE_ENCRYPTION_KEY: 'test-cookie-key',
  USER_MAPPING: JSON.stringify({
    'me@functn.com': { userId: 123, apiToken: 'rotated-token' },
    'admin@functn.com': { userId: 1, apiToken: 'admin-token', isAdmin: true },
  }),
} as unknown as Env;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const get = (path: string, init?: RequestInit, withEnv: Env = env) =>
  worker.fetch(new Request(`https://productive-mcp.functn.com${path}`, init) as never, withEnv, ctx);

describe('discovery', () => {
  test('the protected resource is the one existing grants are bound to', async () => {
    const metadata = (await (await get('/.well-known/oauth-protected-resource/mcp')).json()) as Record<string, unknown>;
    expect(metadata.resource).toBe('https://productive-mcp.functn.com/mcp');
    expect(metadata.authorization_servers).toEqual(['https://productive-mcp.functn.com']);
  });

  test('keeps the pre-1.x endpoint paths and offers Client ID Metadata Documents', async () => {
    const metadata = (await (await get('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
    expect(metadata.authorization_endpoint).toBe('https://productive-mcp.functn.com/authorize');
    expect(metadata.token_endpoint).toBe('https://productive-mcp.functn.com/token');
    expect(metadata.registration_endpoint).toBe('https://productive-mcp.functn.com/register');
    expect(metadata.client_id_metadata_document_supported).toBe(true);
  });

  test('/mcp without a token points the client at the resource metadata', async () => {
    const response = await get('/mcp', { method: 'POST' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://productive-mcp.functn.com/.well-known/oauth-protected-resource/mcp"'
    );
  });

  test('a refused OAuth request is an info line with its status', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    try {
      const response = await get('/register');
      expect(response.status).toBe(405);
      expect(JSON.parse(String(info.mock.calls.slice(-1)[0]?.[0]))).toMatchObject({
        event: 'oauth.error_response',
        statusCode: 405,
        code: 'invalid_request',
      });
    } finally {
      info.mockRestore();
    }
  });

  test('refuses to sign in clients outside the allowlist', async () => {
    const response = await get('/authorize?client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fevil.example%2Fcb');
    expect(response.status).toBe(400);
  });
});

describe('recheckOnRefresh', () => {
  const realFetch = globalThis.fetch;
  let info: ReturnType<typeof spyOn>;
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    info = spyOn(console, 'info').mockImplementation(() => {});
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    info.mockRestore();
    warn.mockRestore();
  });
  const refreshLine = () => JSON.parse(String(info.mock.calls.slice(-1)[0]?.[0]));

  const grant = (extra: Partial<Props> = {}): Props => ({
    accessToken: 'old',
    email: 'me@functn.com',
    login: 'sub',
    name: 'Me',
    productiveUserId: '123',
    productiveApiToken: 'old-token',
    ...extra,
  });
  const refresh = (props: Props) => recheckOnRefresh({ grantType: 'refresh_token', props, env });
  const accessAnswers = (response: Response | Error) => {
    const calls: Array<URLSearchParams> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push(new URLSearchParams(String(init?.body)));
      if (response instanceof Error) throw response;
      return response;
    }) as typeof fetch;
    return calls;
  };
  const oauthCode = async (pending: Promise<unknown>) => {
    try {
      await pending;
    } catch (error) {
      return error instanceof OAuthError ? error.code : String(error);
    }
    return 'no error';
  };

  test('ignores code exchanges', async () => {
    expect(await recheckOnRefresh({ grantType: 'authorization_code', props: grant(), env })).toBeUndefined();
  });

  test('picks up rotated Productive tokens and the admin token from USER_MAPPING', async () => {
    accessAnswers(Response.json({ refresh_token: 'access-2' }));
    const { newProps } = (await refresh(grant({ accessRefreshToken: 'access-1' })))!;
    expect(newProps.productiveApiToken).toBe('rotated-token');
    expect(newProps.adminApiToken).toBe('admin-token');
    expect(newProps.accessRefreshToken).toBe('access-2');
    expect(refreshLine()).toMatchObject({ event: 'oauth.refresh', actor: 'me@functn.com', result: 'ok', accessRotated: true });
    expect(JSON.stringify(info.mock.calls)).not.toContain('access-2');
  });

  test('revokes the grant of a user removed from USER_MAPPING', async () => {
    expect(await oauthCode(refresh(grant({ email: 'gone@functn.com', accessRefreshToken: 'a' })))).toBe('invalid_grant');
    expect(refreshLine()).toMatchObject({
      event: 'oauth.refresh',
      actor: 'gone@functn.com',
      result: 'skipped',
      statusCode: 400,
      reason: 'not_in_user_mapping',
    });
  });

  test('re-checks Cloudflare Access with the stored refresh token', async () => {
    const calls = accessAnswers(Response.json({}));
    const { newProps } = (await refresh(grant({ accessRefreshToken: 'access-1' })))!;
    expect(calls[0]!.get('grant_type')).toBe('refresh_token');
    expect(calls[0]!.get('refresh_token')).toBe('access-1');
    expect(newProps.accessRefreshToken).toBe('access-1');
  });

  test('revokes the grant when Access refuses the refresh', async () => {
    accessAnswers(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    expect(await oauthCode(refresh(grant({ accessRefreshToken: 'access-1' })))).toBe('invalid_grant');
  });

  test('keeps the grant when Access is unreachable, and the refresh fails at error (D6)', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failedLine = () => JSON.parse(String(error.mock.calls.slice(-1)[0]?.[0]));
      accessAnswers(new Error('network down'));
      expect(await oauthCode(refresh(grant({ accessRefreshToken: 'access-1' })))).toBe('temporarily_unavailable');
      expect(failedLine()).toMatchObject({ event: 'oauth.refresh', result: 'failed', reason: 'access_unreachable' });
      expect(checkLine(String(error.mock.calls.slice(-1)[0]?.[0]), 'error')).toEqual([]);
      accessAnswers(new Response('oops', { status: 502 }));
      expect(await oauthCode(refresh(grant({ accessRefreshToken: 'access-1' })))).toBe('temporarily_unavailable');
      expect(failedLine()).toMatchObject({ result: 'failed', reason: 'access_failing', accessStatus: 502 });
      // Our client secret refused: every session would end, so it is ours, not a refusal.
      accessAnswers(Response.json({ error: 'invalid_client' }, { status: 401 }));
      expect(await oauthCode(refresh(grant({ accessRefreshToken: 'access-1' })))).toBe('temporarily_unavailable');
      expect(failedLine()).toMatchObject({ result: 'failed', reason: 'access_client_refused', accessError: 'invalid_client' });
      expect(error).toHaveBeenCalledTimes(3);
    } finally {
      error.mockRestore();
    }
  });

  test('keeps the grant when USER_MAPPING is unreadable, and fails at error', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const broken = { ...env, USER_MAPPING: '{not json' } as unknown as Env;
      const pending = recheckOnRefresh({ grantType: 'refresh_token', props: grant({ accessRefreshToken: 'a' }), env: broken });
      expect(await oauthCode(pending)).toBe('temporarily_unavailable');
      expect(JSON.parse(String(error.mock.calls.slice(-1)[0]?.[0]))).toMatchObject({
        event: 'oauth.refresh',
        result: 'failed',
        reason: 'user_mapping_invalid',
      });
    } finally {
      error.mockRestore();
    }
  });

  test('gives grants from before the upgrade one more day', async () => {
    const { newProps } = (await refresh(grant()))!;
    expect(newProps.reauthBy).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(await oauthCode(refresh(grant({ reauthBy: Date.now() - 1 })))).toBe('invalid_grant');
  });
});

/** The console methods' lines as parsed JSON with `level`, in the order they were written. */
function captureLines() {
  const spies = (['info', 'warn', 'error'] as const).map((level) => spyOn(console, level).mockImplementation(() => {}));
  return {
    lines: () =>
      spies
        .flatMap((spy, i) =>
          spy.mock.calls.map((call: unknown[], n: number) => ({
            order: spy.mock.invocationCallOrder[n]!,
            raw: String(call[0]),
            level: (['info', 'warn', 'error'] as const)[i]!,
          })),
        )
        .sort((x, y) => x.order - y.order)
        .map(({ raw, level }) => ({ level, raw, ...JSON.parse(raw) }) as Record<string, unknown> & { level: string; raw: string }),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

describe('sign-in failures', () => {
  const realFetch = globalThis.fetch;
  let capture: ReturnType<typeof captureLines>;
  beforeEach(() => {
    capture = captureLines();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    capture.restore();
  });
  /** Every line the test wrote follows the logging convention. */
  const conventional = () => {
    for (const line of capture.lines()) expect({ line: line.raw, problems: checkLine(line.raw, line.level as 'info') }).toMatchObject({ problems: [] });
  };

  async function registeredClient(): Promise<string> {
    const response = await get('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none' }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { client_id: string }).client_id;
  }

  const authorizeQuery = (clientId: string, extra: Record<string, string> = {}) =>
    new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: CLAUDE_CALLBACK,
      state: 'claude-state',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      ...extra,
    }).toString();

  test('/authorize for an unknown client is a page, not Cloudflare\'s 1101', async () => {
    const response = await get(`/authorize?${authorizeQuery('nobody')}`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(capture.lines().slice(-1)[0]).toMatchObject({ level: 'info', event: 'mcp.sign_in_refused', statusCode: 400 });
    conventional();
  });

  test('/authorize without PKCE goes back to the client with the error', async () => {
    const clientId = await registeredClient();
    const response = await get(`/authorize?${authorizeQuery(clientId, { code_challenge: '' })}`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('claude-state');
    conventional();
  });

  test('/authorize sends a valid request on to Access', async () => {
    const clientId = await registeredClient();
    const response = await get(`/authorize?${authorizeQuery(clientId)}`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toStartWith(String(env.ACCESS_AUTHORIZATION_URL));
  });

  test('/authorize: a KV outage after the client is known goes back to it as server_error', async () => {
    const clientId = await registeredClient();
    const kv = env.OAUTH_KV;
    const broken = {
      ...env,
      OAUTH_KV: {
        ...kv,
        get: kv.get.bind(kv),
        put: async (key: string, ...rest: unknown[]) => {
          if (key.startsWith('oauth:state:')) throw new Error('KV down');
          return (kv.put as (...args: unknown[]) => unknown)(key, ...rest);
        },
      },
    } as unknown as Env;
    const response = await get(`/authorize?${authorizeQuery(clientId)}`, undefined, broken);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('server_error');
    expect(location.searchParams.get('state')).toBe('claude-state');
    expect(capture.lines().filter((line) => line.level === 'error')).toEqual([
      expect.objectContaining({ event: 'request.failed' }),
    ]);
  });

  /** A sign-in in progress, as /authorize stored it, and its callback URL with Access's answer. */
  async function callback(query: Record<string, string>) {
    const { stateToken } = await createOAuthState(
      { responseType: 'code', clientId: 'claude', redirectUri: CLAUDE_CALLBACK, scope: [], state: 'claude-state' },
      env.OAUTH_KV,
      env.COOKIE_ENCRYPTION_KEY,
    );
    return get(`/callback?${new URLSearchParams({ state: stateToken, ...query })}`, { headers: { accept: 'text/html' } });
  }
  const errorOf = (response: Response) => new URL(response.headers.get('location')!).searchParams;

  test('/callback without a sign-in in progress is a page saying to start again', async () => {
    const response = await get('/callback?state=forged.00', { headers: { accept: 'text/html' } });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Start connecting to Productive again from Claude');
    expect(capture.lines().slice(-1)[0]).toMatchObject({ level: 'info', event: 'mcp.sign_in_refused', reason: 'state_forged' });
    conventional();
  });

  test('/callback: a sign-in cancelled at Access goes back to Claude as access_denied', async () => {
    const response = await callback({ error: 'access_denied' });
    expect(response.status).toBe(302);
    expect(errorOf(response).get('error')).toBe('access_denied');
    expect(errorOf(response).get('state')).toBe('claude-state');
    expect(capture.lines().slice(-1)[0]).toMatchObject({ level: 'info', event: 'mcp.sign_in_refused', reason: 'access_denied' });
    conventional();
  });

  test("/callback: Access refusing our client secret is ours, and Access's body never reaches the person", async () => {
    globalThis.fetch = (async () =>
      Response.json({ error: 'invalid_client', error_description: 'secret-ish detail' }, { status: 401 })) as unknown as typeof fetch;
    const response = await callback({ code: 'c' });
    expect(response.status).toBe(302);
    expect(errorOf(response).get('error')).toBe('temporarily_unavailable');
    expect(response.headers.get('location')).not.toContain('secret-ish');
    expect(capture.lines().filter((line) => line.level === 'error')).toEqual([
      expect.objectContaining({ event: 'mcp.sign_in_failed', reason: 'access_client_refused', accessStatus: 401 }),
    ]);
    conventional();
  });

  test('/callback: Access unreachable goes back to Claude as temporarily_unavailable, one error line', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const response = await callback({ code: 'c' });
    expect(errorOf(response).get('error')).toBe('temporarily_unavailable');
    expect(capture.lines().filter((line) => line.level === 'error')).toEqual([
      expect.objectContaining({ event: 'mcp.sign_in_failed', reason: 'access_unreachable' }),
    ]);
  });

  test('/callback: Access keys unreachable is ours, not a crash', async () => {
    const idToken = ['{"alg":"RS256","kid":"k"}', '{"email":"me@functn.com"}', 'sig']
      .map((part, i) => (i < 2 ? Buffer.from(part).toString('base64url') : part))
      .join('.');
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === env.ACCESS_JWKS_URL) throw new TypeError('fetch failed');
      return Response.json({ access_token: 'a', id_token: idToken });
    }) as unknown as typeof fetch;
    const response = await callback({ code: 'c' });
    expect(errorOf(response).get('error')).toBe('temporarily_unavailable');
    expect(capture.lines().filter((line) => line.level === 'error')).toEqual([
      expect.objectContaining({ event: 'mcp.sign_in_failed', reason: 'access_keys_unavailable' }),
    ]);
  });
});

describe('failures outside sign-in', () => {
  let capture: ReturnType<typeof captureLines>;
  beforeEach(() => {
    capture = captureLines();
  });
  afterEach(() => capture.restore());

  test('/token answers OAuth JSON when KV is down, with one error line', async () => {
    const broken = {
      ...env,
      OAUTH_KV: { ...env.OAUTH_KV, get: async () => Promise.reject(new Error('KV down')) },
    } as unknown as Env;
    const response = await get(
      '/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token&refresh_token=a:b:c&client_id=x',
      },
      broken,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'server_error' });
    expect(capture.lines().filter((line) => line.level === 'error')).toHaveLength(1);
  });

  test("the MCP SDK's own 500s are an error line, its rejections an info line", () => {
    reportMcpError(new Error('Rejected inbound request (header): Mcp-Method does not match'));
    reportMcpError(new Error('Unsupported Media Type: Content-Type must be application/json'));
    reportMcpError(new TypeError('factory broke'));
    expect(capture.lines().map((line) => [line.level, line.event])).toEqual([
      ['info', 'mcp.request_rejected'],
      ['info', 'mcp.request_rejected'],
      ['error', 'mcp.request_failed'],
    ]);
  });
});
