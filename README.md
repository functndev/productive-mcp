# Productive MCP Worker

Cloudflare Worker hosting a remote [Model Context Protocol](https://modelcontextprotocol.io/) server for the [Productive.io](https://productive.io) API, fronted by **Cloudflare Access for SaaS** acting as the upstream OAuth provider.

## How auth works

This Worker uses the [Access for SaaS](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/#access-for-saas-application) pattern via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider). MCP clients (e.g. Claude Desktop) perform standard OAuth 2.1 dynamic client registration against the Worker; the Worker brokers the actual login through your Access for SaaS OIDC application.

Flow:

1. MCP client hits `/authorize`. The Worker shows a consent screen, then redirects to your Access for SaaS authorization endpoint (PKCE).
2. User authenticates through Access (any IdP you have configured).
3. Access redirects back to `/callback` with an authorization code. The Worker exchanges it for `access_token` + `id_token`, verifies the `id_token` against `ACCESS_JWKS_URL`, and reads the `email` claim.
4. Email is looked up in the `USER_MAPPING` secret. Unknown emails get `403`.
5. Worker calls `OAUTH_PROVIDER.completeAuthorization()` with `props` containing the resolved `productiveUserId` + `productiveApiToken`. Those props are persisted in `OAUTH_KV` and exposed as `this.props` inside the MCP Durable Object on every subsequent `/mcp` request.

## Endpoints

| Path                                 | Purpose                                       |
| ------------------------------------ | --------------------------------------------- |
| `GET /authorize` / `POST /authorize` | OAuth authorization endpoint                  |
| `POST /token`                        | OAuth token endpoint                          |
| `POST /register`                     | OAuth dynamic client registration             |
| `GET /callback`                      | Upstream Access redirect target               |
| `/mcp`                               | Streamable HTTP MCP transport (auth required) |

## Cloudflare setup

### 1. Create the KV namespace

```sh
npx wrangler kv namespace create OAUTH_KV
```

Copy the resulting id into [wrangler.jsonc](wrangler.jsonc) (replacing `<Add-KV-ID>`).

### 2. Create an Access for SaaS OIDC application

In the Cloudflare dashboard: **Zero Trust → Access → Applications → Add an application → SaaS → OIDC**.

- **Application name**: `Productive MCP`
- **Redirect URLs**: `https://<your-worker-host>/callback`
- **Scopes**: `openid`, `email`, `profile`
- Configure Access policies (e.g. emails on your domain).

Copy these from the OIDC settings:

| Field in dashboard     | Secret name                |
| ---------------------- | -------------------------- |
| Client ID              | `ACCESS_CLIENT_ID`         |
| Client secret          | `ACCESS_CLIENT_SECRET`     |
| Authorization endpoint | `ACCESS_AUTHORIZATION_URL` |
| Token endpoint         | `ACCESS_TOKEN_URL`         |
| Key endpoint (JWKS)    | `ACCESS_JWKS_URL`          |

### 3. Set Worker secrets

```sh
# Productive
wrangler secret put PRODUCTIVE_ORG_ID
wrangler secret put USER_MAPPING < users.json

# Access for SaaS
wrangler secret put ACCESS_CLIENT_ID
wrangler secret put ACCESS_CLIENT_SECRET
wrangler secret put ACCESS_AUTHORIZATION_URL
wrangler secret put ACCESS_TOKEN_URL
wrangler secret put ACCESS_JWKS_URL

# Cookie signing key for the consent screen / OAuth state
openssl rand -hex 32 | wrangler secret put COOKIE_ENCRYPTION_KEY
```

`users.json`:

```json
{
  "alice@example.com": { "userId": 123456, "apiToken": "alice-token" },
  "bob@example.com": { "userId": 234567, "apiToken": "bob-token" }
}
```

Email keys are looked up case-insensitively (lowercased).

## Local development

Copy `.dev.vars.example` to `.dev.vars` and fill in values, then:

```sh
npm install
npm run dev
```

A real Access for SaaS app is still required for the OAuth dance to work locally. Either add `http://localhost:8787/callback` as a redirect URL on your existing app, or create a separate dev app.

## Deploying

```sh
npm run deploy
```

## Connecting Claude Desktop / other MCP clients

```json
{
  "mcpServers": {
    "productive": {
      "url": "https://<your-worker-host>/mcp"
    }
  }
}
```

The first request triggers the OAuth flow in your browser. After successful Access login, subsequent requests reuse the issued token
