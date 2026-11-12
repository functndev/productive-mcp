// The OAuth provider configuration (what clients discover), the sign-in through Cloudflare Access
// and apps.functn.com, the checks run on every refresh, and the grant check on every MCP request.
// Access is a stand-in on fetch that signs real RS256 ID tokens; apps.functn.com's Access
// entrypoint a stand-in binding that signs real Ed25519 grants.
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { OAuthError } from '@cloudflare/workers-oauth-provider';
import { APP_ID } from './access.js';
import { resetGrantClientState, type GrantClaims, type TokenError, type TokenResponse } from './apps-functn-com/grant-client.js';
import { reCheckAccessOnRefresh } from './authorize.js';
import type { GrantProps } from './env.js';
import worker, { handleMcpRequest, reportMcpError } from './index.js';
import { checkLine } from './lib/log.js';
import { resetOidcState } from './oidc.js';

const EMAIL = 'me@functn.com';
const CLIENT_ID = 'access-client';
const ISSUER = `https://functn.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${CLIENT_ID}`;
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const nowS = () => Math.floor(Date.now() / 1000);
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const b64json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

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

// ---------------------------------------------------------------------------
// Keys: Access's (RS256 ID tokens) and apps.functn.com's (Ed25519 grants).

let accessKey: CryptoKey;
let accessJwk: JsonWebKey & { kid: string };
let grantKey: CryptoKey;
let grantPublicKeys: string;

beforeAll(async () => {
  const rsa = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  accessKey = rsa.privateKey;
  accessJwk = { ...((await crypto.subtle.exportKey('jwk', rsa.publicKey)) as JsonWebKey), kid: 'k1' };
  const ed = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  grantKey = ed.privateKey;
  const { x } = (await crypto.subtle.exportKey('jwk', ed.publicKey)) as JsonWebKey;
  grantPublicKeys = JSON.stringify({ keys: [{ kty: 'OKP', crv: 'Ed25519', x, kid: 'test' }] });
});

/** An ID token as Access would sign it; `header` and `claims` override. */
async function idToken(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
  const input = `${b64json({ alg: 'RS256', kid: 'k1', ...header })}.${b64json({
    iss: ISSUER,
    aud: [CLIENT_ID],
    sub: 'sub-1',
    email: 'Me@functn.com',
    name: 'Me',
    iat: nowS(),
    exp: nowS() + 3600,
    ...claims,
  })}`;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', accessKey, new TextEncoder().encode(input)));
  return `${input}.${b64url(signature)}`;
}

async function grantFor(roles: string[]): Promise<TokenResponse> {
  const iat = nowS();
  const claims: GrantClaims = {
    iss: 'https://apps.functn.com',
    sub: EMAIL,
    aud: APP_ID,
    client_id: APP_ID,
    iat,
    exp: iat + 600,
    jti: crypto.randomUUID(),
    email: EMAIL,
    given_name: 'Me',
    family_name: 'M',
    name: 'Me M',
    roles,
    groups: ['everyone'],
    entitlements: [`app:${APP_ID}`],
    'https://apps.functn.com/catalog': 1,
    'https://apps.functn.com/personio_id': null,
  };
  const input = `${b64json({ alg: 'EdDSA', kid: 'test', typ: 'at+jwt' })}.${b64json(claims)}`;
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', grantKey, new TextEncoder().encode(input)));
  return {
    access_token: `${input}.${b64url(signature)}`,
    issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    token_type: 'Bearer',
    expires_in: 600,
    claims,
  };
}

// ---------------------------------------------------------------------------
// Stand-ins: Cloudflare Access (on fetch) and apps.functn.com (bindings).

/** What Access's token endpoint answers next; `fetched` counts its endpoints' calls. */
let accessToken: () => Promise<Response>;
let jwksDown = false;
const fetched: string[] = [];
const realFetch = globalThis.fetch;

function access() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url.replace(ISSUER, ''));
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorization`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      });
    }
    if (url === `${ISSUER}/jwks`) {
      if (jwksDown) throw new TypeError('fetch failed');
      return Response.json({ keys: [accessJwk] });
    }
    if (url === `${ISSUER}/token`) {
      lastTokenRequest = new URLSearchParams(String(init?.body));
      return accessToken();
    }
    return new Response('unexpected', { status: 599 });
  }) as typeof fetch;
}
let lastTokenRequest: URLSearchParams | undefined;

/** What apps.functn.com's Access entrypoint answers next: roles, an error, or a thrown failure. */
let appsAnswer: string[] | TokenError['error'] | 'down';
const exchanged: string[] = [];
const ACCESS = {
  async grant(request: { subject_token: string }): Promise<TokenResponse | TokenError> {
    exchanged.push(request.subject_token);
    if (appsAnswer === 'down') throw new Error('connection refused');
    if (typeof appsAnswer === 'string') {
      return { error: appsAnswer, error_description: 'No role in Productive', appsUrl: 'https://apps.functn.com/people' };
    }
    return grantFor(appsAnswer);
  },
  async catalog() {
    return { unchanged: true as const, version: 1 };
  },
  async jwks() {
    return { keys: [] };
  },
};
const CONNECTIONS = {
  async status() {
    return { ok: true, state: 'connected', account: { id: '123', name: 'Me', email: EMAIL }, connectUrl: '' };
  },
};

let env: Env;
beforeEach(() => {
  env = {
    OAUTH_KV: memoryKv(),
    PUBLIC_URL: 'https://productive-mcp.functn.com',
    PRODUCTIVE_API_BASE_URL: 'https://api.productive.io/api/v2/',
    ACCESS_ISSUER: ISSUER,
    ACCESS_CLIENT_ID: CLIENT_ID,
    ACCESS_CLIENT_SECRET: 'access-secret',
    COOKIE_ENCRYPTION_KEY: 'test-cookie-key',
    ACCESS,
    GRANT_PUBLIC_KEYS: grantPublicKeys,
    CONNECTIONS,
  } as unknown as Env;
  resetGrantClientState();
  resetOidcState();
  exchanged.length = 0;
  fetched.length = 0;
  jwksDown = false;
  appsAnswer = ['editor'];
  lastTokenRequest = undefined;
  accessToken = async () => Response.json({ access_token: 'a', id_token: await idToken(), refresh_token: 'access-refresh' });
  access();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const get = (path: string, init?: RequestInit, withEnv: Env = env) =>
  worker.fetch(new Request(`https://productive-mcp.functn.com${path}`, init) as never, withEnv, ctx);

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
let capture: ReturnType<typeof captureLines>;
beforeEach(() => {
  capture = captureLines();
});
afterEach(() => capture.restore());
/** A JSON-RPC answer, plain or as one server-sent event. */
async function rpcBody(response: Response): Promise<any> {
  const text = await response.text();
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(data ? data.slice(6) : text);
}
const errors = () => capture.lines().filter((line) => line.level === 'error');
/** Every line the test wrote follows the logging convention. */
const conventional = () => {
  for (const line of capture.lines()) {
    expect({ line: line.raw, problems: checkLine(line.raw, line.level as 'info') }).toMatchObject({ problems: [] });
  }
};

describe('discovery', () => {
  test('the protected resource is the one existing grants are bound to', async () => {
    const metadata = (await (await get('/.well-known/oauth-protected-resource/mcp')).json()) as Record<string, unknown>;
    expect(metadata.resource).toBe('https://productive-mcp.functn.com/mcp');
    expect(metadata.authorization_servers).toEqual(['https://productive-mcp.functn.com']);
  });

  test("functn-it mcp/'s fixed paths, one scope, and Client ID Metadata Documents", async () => {
    const metadata = (await (await get('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
    expect(metadata.authorization_endpoint).toBe('https://productive-mcp.functn.com/authorize');
    expect(metadata.token_endpoint).toBe('https://productive-mcp.functn.com/oauth/token');
    expect(metadata.registration_endpoint).toBe('https://productive-mcp.functn.com/oauth/register');
    expect(metadata.scopes_supported).toEqual(['mcp']);
    expect(metadata.client_id_metadata_document_supported).toBe(true);
  });

  test('/mcp without a token points the client at the resource metadata', async () => {
    const response = await get('/mcp', { method: 'POST' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://productive-mcp.functn.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test.each(['/oauth/register', '/register'])('a refused OAuth request at %s is an info line with its status', async (path) => {
    const response = await get(path);
    expect(response.status).toBe(405);
    expect(capture.lines().slice(-1)[0]).toMatchObject({ event: 'oauth.error_response', statusCode: 405, code: 'invalid_request' });
  });

  test('the old /token still answers refreshes of connectors added before the move', async () => {
    const response = await get('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=a:b:c&client_id=x',
    });
    expect(response.status).not.toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/^invalid_/) });
  });

  test('/callback is gone: only Access used it', async () => {
    expect((await get('/callback?state=x&code=y')).status).toBe(404);
  });

  test('refuses to sign in clients outside the allowlist', async () => {
    const response = await get('/authorize?client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fevil.example%2Fcb');
    expect(response.status).toBe(400);
  });
});

describe('sign-in', () => {
  async function registeredClient(): Promise<string> {
    const response = await get('/oauth/register', {
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
      scope: 'everything please',
      ...extra,
    }).toString();

  /** /authorize, then Access's redirect back with `query` (by default a code), with the binding cookie. */
  async function signIn(query: Record<string, string> = { code: 'access-code' }) {
    const clientId = await registeredClient();
    const authorize = await get(`/authorize?${authorizeQuery(clientId)}`);
    expect(authorize.status).toBe(302);
    const toAccess = new URL(authorize.headers.get('location')!);
    const cookie = authorize.headers.get('set-cookie')!.split(';')[0]!;
    const response = await get(
      `/oauth/access/callback?${new URLSearchParams({ state: toAccess.searchParams.get('state')!, ...query })}`,
      { headers: { cookie, accept: 'text/html' } },
    );
    return { clientId, toAccess, response };
  }
  const redirectOf = (response: Response) => new URL(response.headers.get('location')!);

  test('/authorize sends a valid request on to Access, with PKCE and the fixed callback', async () => {
    const { toAccess } = await signIn();
    expect(`${toAccess.origin}${toAccess.pathname}`).toBe(`${ISSUER}/authorization`);
    expect(toAccess.searchParams.get('redirect_uri')).toBe('https://productive-mcp.functn.com/oauth/access/callback');
    expect(toAccess.searchParams.get('code_challenge_method')).toBe('S256');
    expect(toAccess.searchParams.get('scope')).toBe('openid email profile offline_access');
  });

  test('a sign-in asks apps.functn.com with the ID token and goes back to Claude with a code', async () => {
    const { response } = await signIn();
    expect(response.status).toBe(302);
    const back = redirectOf(response);
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get('code')).toBeString();
    expect(back.searchParams.get('state')).toBe('claude-state');
    // The PKCE verifier went to Access with the code.
    expect(lastTokenRequest?.get('code_verifier')).toBeString();
    expect(exchanged).toHaveLength(1);
    expect(capture.lines().find((line) => line.event === 'audit.mcp.sign_in')).toMatchObject({
      level: 'info',
      actor: EMAIL,
      role: 'editor',
      accessRefresh: true,
    });
    conventional();
  });

  test('the whole round trip: the code becomes an access token for /mcp with scope mcp, 10 minutes', async () => {
    const clientId = await registeredClient();
    const verifier = 'v'.repeat(64);
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
    const authorize = await get(`/authorize?${authorizeQuery(clientId, { code_challenge: challenge })}`);
    const cookie = authorize.headers.get('set-cookie')!.split(';')[0]!;
    const state = new URL(authorize.headers.get('location')!).searchParams.get('state')!;
    const callback = await get(`/oauth/access/callback?state=${state}&code=c`, { headers: { cookie } });
    const code = redirectOf(callback).searchParams.get('code')!;
    const token = await get('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_verifier: verifier }),
    });
    const body = (await token.json()) as { access_token: string; scope: string; expires_in: number };
    expect(body.scope).toBe('mcp');
    expect(body.expires_in).toBe(600);
    const mcp = await get('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${body.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(mcp.status).toBe(200);
    expect(JSON.stringify(await rpcBody(mcp))).toContain('create_task');
  });

  test('the Access keys are fetched once per isolate, not per sign-in', async () => {
    await signIn();
    await signIn();
    expect(fetched.filter((url) => url === '/jwks')).toHaveLength(1);
  });

  test.each([
    ['another issuer', { iss: 'https://functn.cloudflareaccess.com/cdn-cgi/access/sso/oidc/other' }, {}],
    ['another audience', { aud: ['other'] }, {}],
    ['an expired token', { exp: nowS() - 120 }, {}],
    ['a token not valid yet', { nbf: nowS() + 600 }, {}],
    ['HS256', {}, { alg: 'HS256' }],
    ['no kid', {}, { kid: undefined }],
  ])('an ID token with %s is refused, with one error line and no grant', async (_, claims, header) => {
    accessToken = async () => Response.json({ access_token: 'a', id_token: await idToken(claims, header), refresh_token: 'r' });
    const { response } = await signIn();
    expect(redirectOf(response).searchParams.get('error')).toBe('server_error');
    expect(exchanged).toEqual([]);
    expect(errors()).toEqual([expect.objectContaining({ event: 'mcp.sign_in_failed', reason: 'access_sign_in_failed' })]);
  });

  test('no role on apps.functn.com is access_denied with where to ask, at info', async () => {
    appsAnswer = 'access_denied';
    const { response } = await signIn();
    const back = redirectOf(response);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('error_description')).toContain('https://apps.functn.com/people');
    expect(errors()).toEqual([]);
    expect(capture.lines().slice(-1)[0]).toMatchObject({ level: 'info', event: 'mcp.sign_in_refused', reason: 'access_denied' });
    conventional();
  });

  test('apps.functn.com unreachable is temporarily_unavailable, one error line', async () => {
    appsAnswer = 'down';
    const { response } = await signIn();
    expect(redirectOf(response).searchParams.get('error')).toBe('temporarily_unavailable');
    expect(errors()).toEqual([expect.objectContaining({ event: 'mcp.sign_in_failed' })]);
  });

  test('apps.functn.com calling our request a bug (no app for the caller) is server_error, ours', async () => {
    appsAnswer = 'invalid_client';
    const { response } = await signIn();
    expect(redirectOf(response).searchParams.get('error')).toBe('server_error');
    expect(errors()).toEqual([expect.objectContaining({ event: 'mcp.sign_in_failed', reason: 'invalid_client' })]);
  });

  test('a sign-in cancelled at Access goes back to Claude as access_denied', async () => {
    const { response } = await signIn({ error: 'access_denied' });
    expect(redirectOf(response).searchParams.get('error')).toBe('access_denied');
    expect(redirectOf(response).searchParams.get('state')).toBe('claude-state');
    conventional();
  });

  test("Access refusing our client secret is ours, and Access's body never reaches the person", async () => {
    accessToken = async () => Response.json({ error: 'invalid_client', error_description: 'secret-ish detail' }, { status: 401 });
    const { response } = await signIn();
    expect(redirectOf(response).searchParams.get('error')).toBe('server_error');
    expect(response.headers.get('location')).not.toContain('secret-ish');
    expect(errors()).toHaveLength(1);
  });

  test('Access unreachable is temporarily_unavailable, one error line', async () => {
    accessToken = async () => {
      throw new TypeError('fetch failed');
    };
    const { response } = await signIn();
    expect(redirectOf(response).searchParams.get('error')).toBe('temporarily_unavailable');
    expect(errors()).toEqual([expect.objectContaining({ event: 'mcp.sign_in_failed', reason: 'access_unavailable' })]);
  });

  test('Access keys unreachable is ours, not a crash', async () => {
    jwksDown = true;
    const { response } = await signIn();
    expect(redirectOf(response).searchParams.get('error')).toBe('temporarily_unavailable');
    expect(errors()).toHaveLength(1);
  });

  test('a callback without a sign-in in progress is a page saying to start again', async () => {
    const response = await get('/oauth/access/callback?state=forged&code=c', { headers: { accept: 'text/html' } });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Start connecting to Productive again from Claude');
    expect(capture.lines().slice(-1)[0]).toMatchObject({ level: 'info', event: 'mcp.sign_in_refused', reason: 'upstream_state_invalid' });
    conventional();
  });

  test('/authorize for an unknown client is a page, not Cloudflare\'s 1101', async () => {
    const response = await get(`/authorize?${authorizeQuery('nobody')}`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('text/html');
    conventional();
  });

  test('/authorize without PKCE goes back to the client with the error', async () => {
    const clientId = await registeredClient();
    const response = await get(`/authorize?${authorizeQuery(clientId, { code_challenge: '' })}`);
    expect(response.status).toBe(302);
    expect(redirectOf(response).searchParams.get('error')).toBe('invalid_request');
    expect(redirectOf(response).searchParams.get('state')).toBe('claude-state');
  });
});

describe('reCheckAccessOnRefresh', () => {
  const props = async (extra: Partial<GrantProps> = {}): Promise<GrantProps> => ({
    email: EMAIL,
    grant: (await grantFor(['editor'])).access_token,
    accessRefreshToken: 'access-refresh',
    idToken: 'old-id-token',
    idTokenExpiresAt: Date.now() + 60_000,
    ...extra,
  });
  const refresh = (current: unknown) => reCheckAccessOnRefresh({ grantType: 'refresh_token', props: current, env });
  const oauthCode = async (pending: Promise<unknown>) => {
    try {
      await pending;
    } catch (error) {
      return error instanceof OAuthError ? error.code : String(error);
    }
    return 'no error';
  };
  const refreshLine = () => capture.lines().find((line) => line.event === 'mcp.token_refresh');

  test('ignores code exchanges', async () => {
    expect(await reCheckAccessOnRefresh({ grantType: 'authorization_code', props: await props(), env })).toBeUndefined();
  });

  test('renews the grant and the ID token through Access and apps.functn.com', async () => {
    const fresh = await idToken();
    accessToken = async () => Response.json({ access_token: 'a', id_token: fresh, refresh_token: 'rotated' });
    const { newProps } = (await refresh(await props()))!;
    expect(lastTokenRequest?.get('refresh_token')).toBe('access-refresh');
    expect(exchanged).toEqual([fresh]);
    expect(newProps).toMatchObject({ email: EMAIL, accessRefreshToken: 'rotated', idToken: fresh });
    expect(newProps.idTokenExpiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
    expect(refreshLine()).toMatchObject({ level: 'info', result: 'ok', role: 'editor', idTokenRenewed: true });
    conventional();
  });

  test('moves a grant from before the convention over, dropping its Productive tokens', async () => {
    const legacy = {
      accessToken: 'old',
      email: 'Me@functn.com',
      login: 'sub',
      name: 'Me',
      productiveUserId: '123',
      productiveApiToken: 'personal-token',
      adminApiToken: 'admin-token',
      accessRefreshToken: 'access-refresh',
    };
    const { newProps } = (await refresh(legacy))!;
    expect(Object.keys(newProps).sort()).toEqual(['accessRefreshToken', 'email', 'grant', 'idToken', 'idTokenExpiresAt']);
    expect(newProps.email).toBe(EMAIL);
    expect(JSON.stringify(newProps)).not.toContain('admin-token');
  });

  test('ends the session when Access refuses the refresh', async () => {
    accessToken = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
    expect(await oauthCode(refresh(await props()))).toBe('invalid_grant');
    expect(refreshLine()).toMatchObject({ level: 'info', result: 'skipped', statusCode: 400 });
    expect(errors()).toEqual([]);
  });

  test('ends the session when apps.functn.com no longer gives a role', async () => {
    appsAnswer = 'access_denied';
    expect(await oauthCode(refresh(await props()))).toBe('invalid_grant');
    expect(errors()).toEqual([]);
  });

  test.each([
    ['Access unreachable', () => {
      accessToken = async () => {
        throw new TypeError('fetch failed');
      };
    }, 'temporarily_unavailable'],
    ['Access refusing our client', () => {
      accessToken = async () => Response.json({ error: 'invalid_client' }, { status: 401 });
    }, 'temporarily_unavailable'],
    ['apps.functn.com calling our request a bug', () => {
      appsAnswer = 'invalid_client';
    }, 'server_error'],
  ])('%s keeps the grant, and the refresh fails at error (D6)', async (_, arrange, code) => {
    arrange();
    expect(await oauthCode(refresh(await props()))).toBe(code);
    expect(errors()).toEqual([expect.objectContaining({ event: 'mcp.token_refresh', result: 'failed' })]);
  });

  test('apps.functn.com unreachable serves the old grant while it is in its grace', async () => {
    appsAnswer = 'down';
    const current = await props();
    const { newProps } = (await refresh(current))!;
    expect(newProps.grant).toBe(current.grant);
  });

  test('without an Access refresh token: refreshed until the re-auth deadline, then sign in again', async () => {
    expect(await refresh(await props({ accessRefreshToken: undefined, reauthBy: Date.now() + 60_000 }))).toBeUndefined();
    expect(await oauthCode(refresh(await props({ accessRefreshToken: undefined, reauthBy: Date.now() - 1 })))).toBe('invalid_grant');
  });
});

describe('MCP requests', () => {
  const tools = (props: Partial<GrantProps>) =>
    handleMcpRequest(
      new Request('https://productive-mcp.functn.com/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      env,
      props as GrantProps,
    );
  const valid = async (roles: string[]) => ({
    email: EMAIL,
    grant: (await grantFor(roles)).access_token,
    idToken: 'id',
    idTokenExpiresAt: Date.now() + 30 * 60_000,
  } as const);

  test('a grant from before the convention is a 401 invalid_token, so the client refreshes (never a 403)', async () => {
    const response = await tools({ email: EMAIL });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toStartWith('Bearer error="invalid_token"');
    expect(capture.lines().slice(-1)[0]).toMatchObject({ level: 'info', event: 'mcp.request_refused', statusCode: 401 });
  });

  test('a grant for someone else is a 401', async () => {
    expect((await tools({ ...(await valid(['editor'])), email: 'other@functn.com' })).status).toBe(401);
  });

  test('an ID token about to expire is a 401, so the refresh renews it', async () => {
    const response = await tools({ ...(await valid(['editor'])), idTokenExpiresAt: Date.now() + 10_000 });
    expect(response.status).toBe(401);
    expect(capture.lines().slice(-1)[0]).toMatchObject({ reason: 'id_token_expired' });
  });

  test("the tools follow the grant's role", async () => {
    const editor = await rpcBody(await tools(await valid(['editor'])));
    const reader = await rpcBody(await tools(await valid(['reader'])));
    expect(editor.result.tools).toHaveLength(47);
    expect(reader.result.tools).toHaveLength(29);
  });
});

describe('failures outside sign-in', () => {
  test.each(['/oauth/token', '/token'])('%s answers OAuth JSON when KV is down, with one error line', async (path) => {
    const broken = {
      ...env,
      OAUTH_KV: { ...env.OAUTH_KV, get: async () => Promise.reject(new Error('KV down')) },
    } as unknown as Env;
    const response = await get(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token&refresh_token=a:b:c&client_id=x',
      },
      broken,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'server_error' });
    expect(errors()).toHaveLength(1);
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
