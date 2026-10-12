// The OAuth provider configuration (what clients discover) and the checks run on every refresh.
import { afterEach, describe, expect, test } from 'bun:test';
import { OAuthError } from '@cloudflare/workers-oauth-provider';
import { recheckOnRefresh } from './access-handler.js';
import worker from './index.js';
import type { Props } from './workers-oauth-utils.js';

/** Just enough of KVNamespace for the provider's metadata and 401 paths. */
function memoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
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
  USER_MAPPING: JSON.stringify({
    'me@functn.com': { userId: 123, apiToken: 'rotated-token' },
    'admin@functn.com': { userId: 1, apiToken: 'admin-token', isAdmin: true },
  }),
} as unknown as Env;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const get = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`https://productive-mcp.functn.com${path}`, init) as never, env, ctx);

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

  test('refuses to sign in clients outside the allowlist', async () => {
    const response = await get('/authorize?client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fevil.example%2Fcb');
    expect(response.status).toBe(400);
  });
});

describe('recheckOnRefresh', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

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
  });

  test('revokes the grant of a user removed from USER_MAPPING', async () => {
    expect(await oauthCode(refresh(grant({ email: 'gone@functn.com', accessRefreshToken: 'a' })))).toBe('invalid_grant');
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

  test('keeps the grant when Access is unreachable', async () => {
    accessAnswers(new Error('network down'));
    expect(await oauthCode(refresh(grant({ accessRefreshToken: 'access-1' })))).toBe('temporarily_unavailable');
    accessAnswers(new Response('oops', { status: 502 }));
    expect(await oauthCode(refresh(grant({ accessRefreshToken: 'access-1' })))).toBe('temporarily_unavailable');
  });

  test('gives grants from before the upgrade one more day', async () => {
    const { newProps } = (await refresh(grant()))!;
    expect(newProps.reauthBy).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(await oauthCode(refresh(grant({ reauthBy: Date.now() - 1 })))).toBe('invalid_grant');
  });
});
