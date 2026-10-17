# Productive MCP Worker

Cloudflare Worker hosting a remote [Model Context Protocol](https://modelcontextprotocol.io/) server for the [Productive.io](https://productive.io) API, fronted by **Cloudflare Access for SaaS** acting as the upstream OAuth provider.

## How auth works

This Worker uses the [Access for SaaS](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/#access-for-saas-application) pattern via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider). MCP clients (e.g. Claude Desktop) perform standard OAuth 2.1 dynamic client registration against the Worker; the Worker brokers the actual login through your Access for SaaS OIDC application.

Flow:

1. MCP client hits `/authorize`. The Worker redirects straight to your Access for SaaS authorization endpoint (PKCE), with no page of its own: only Claude's callbacks and local clients may receive tokens (`src/clients.ts`), so there is no consent step.
2. User authenticates through Access (any IdP you have configured).
3. Access redirects back to `/callback` with an authorization code. The Worker exchanges it for `access_token` + `id_token`, verifies the `id_token` against `ACCESS_JWKS_URL`, and reads the `email` claim.
4. Email is looked up in the `USER_MAPPING` secret. Unknown emails get `403`.
5. Worker calls `OAUTH_PROVIDER.completeAuthorization()` with `props` containing the resolved `productiveUserId` + `productiveApiToken`. Those props are persisted in `OAUTH_KV` and passed as `ctx.props` to every subsequent `/mcp` request, which builds a fresh, stateless MCP server for that user.

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
bunx cf kv namespaces create --title OAUTH_KV
```

Put the resulting id into the `OAUTH_KV` binding in [cloudflare.config.ts](cloudflare.config.ts).

### 2. Create an Access for SaaS OIDC application

In the Cloudflare dashboard: **Zero Trust → Access → Applications → Add an application → SaaS → OIDC**.

- **Application name**: `Productive MCP`
- **Redirect URLs**: `https://<your-worker-host>/callback`
- **Scopes**: `openid`, `email`, `profile`
- Configure Access policies (e.g. emails on your domain).

Copy these from the OIDC settings into the 1Password item `productive-mcp` (vault `Infra - L7`).
Only the client secret is a Worker secret; the rest is plain config in `cloudflare.config.ts`:

| Field in dashboard     | Variable                   | Lives in                    |
| ---------------------- | -------------------------- | --------------------------- |
| Client ID              | `ACCESS_CLIENT_ID`         | `cloudflare.config.ts`      |
| Client secret          | `ACCESS_CLIENT_SECRET`     | Worker secret               |
| Authorization endpoint | `ACCESS_AUTHORIZATION_URL` | `cloudflare.config.ts`      |
| Token endpoint         | `ACCESS_TOKEN_URL`         | `cloudflare.config.ts`      |
| Key endpoint (JWKS)    | `ACCESS_JWKS_URL`          | `cloudflare.config.ts`      |

### 3. Set Worker secrets

1Password is the source of truth: the item `productive-mcp` in vault `Infra - L7` holds every value
(secrets and config), one field per variable. `.env.tpl` lists the three secrets as `op://`
references. Change a secret in 1Password, then push it:

```sh
for name in USER_MAPPING ACCESS_CLIENT_SECRET COOKIE_ENCRYPTION_KEY; do
  bunx cf workers secrets update "$name" --worker productive-mcp \
    --text "$(op read "op://Infra - L7/productive-mcp/$name")"
done
```

`COOKIE_ENCRYPTION_KEY` is `openssl rand -hex 32`. `USER_MAPPING` is single-line JSON:

```json
{"alice@example.com":{"userId":123456,"apiToken":"alice-token","isAdmin":true},"bob@example.com":{"userId":234567,"apiToken":"bob-token"}}
```

Email keys are looked up case-insensitively (lowercased).

## Local development

Secrets live in 1Password (vault `Infra - L7`, item `productive-mcp`). `.env.tpl` lists the secrets as `op://` references; write `.env` from it, then:

```sh
op inject -f -i .env.tpl -o .env
npm install
npm run dev      # cf dev
```

A real Access for SaaS app is still required for the OAuth dance to work locally. Either add `http://localhost:8787/callback` as a redirect URL on your existing app, or create a separate dev app.

## Deploying

```sh
npm run deploy   # cf deploy; config in cloudflare.config.ts
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
