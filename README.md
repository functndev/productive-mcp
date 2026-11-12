# Productive MCP Worker

Cloudflare Worker hosting a remote [Model Context Protocol](https://modelcontextprotocol.io/) server for the [Productive.io](https://productive.io) API, fronted by **Cloudflare Access for SaaS** acting as the upstream OAuth provider.

## How auth works

The server follows functn-it's MCP convention (`mcp/README.md`; the Tracking MCP is its model). [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) makes the Worker an OAuth server for MCP clients, and an OIDC client of **Cloudflare Access for SaaS** upstream. apps.functn.com decides who may use it and calls Productive for them.

1. The MCP client hits `/authorize`. Only Claude's callbacks and local clients may receive tokens (`src/clients.ts`), so there is no consent page: the Worker goes straight on to Access (PKCE S256), tying the round trip to the browser with the provider's `beginUpstream`/`finishUpstream`.
2. The person signs in with Google through Access (policy "Functn Team").
3. Access returns to `/oauth/access/callback`. The Worker exchanges the code and verifies the ID token fully (`src/oidc.ts`: RS256 with a `kid`, keys cached per isolate, issuer, audience, `exp`/`nbf`, 15 s timeouts).
4. apps.functn.com's `Access` entrypoint exchanges the ID token for a signed grant with the person's roles in app `productive` (`src/access.ts`). No role is "access denied" with a link to apps.functn.com.
5. The grant props hold only `email`, `grant`, the Access refresh token, and the ID token with its expiry. Access tokens live 10 minutes; every refresh re-checks Access and renews the grant and the ID token (`src/authorize.ts`); every `/mcp` request verifies the grant locally and answers 401 `invalid_token` when it fails.
6. Tools call Productive through apps.functn.com `Connections` with the person's ID token, so each person works with **their own** Productive token, connected on apps.functn.com (`src/api/transport.ts`). `list_users` runs as the system credential `productive-bot`. No Productive token passes through this Worker.
7. Each tool has a minimum role (`src/roles.ts`): `reader` gets the reading tools, `editor` (or `admin`) all of them.

## Endpoints

| Path                                 | Purpose                                       |
| ------------------------------------ | --------------------------------------------- |
| `GET /authorize`                     | OAuth authorization endpoint                  |
| `POST /oauth/token`                  | OAuth token endpoint (old path `/token` kept) |
| `POST /oauth/register`               | OAuth dynamic client registration (old path `/register` kept) |
| `GET /oauth/access/callback`         | Access for SaaS redirect target               |
| `/mcp`                               | Streamable HTTP MCP transport (auth required) |
| `GET /attachments/<id>/<name>?l=…`   | Download links from `get_attachment` (15 min) |

`/token` and `/register` stay because connectors added before the move keep the token endpoint they discovered.

## Cloudflare setup

### 1. KV namespace

`OAUTH_KV` in [cloudflare.config.ts](cloudflare.config.ts) holds the OAuth grants, purged daily by the cron.

### 2. Access for SaaS OIDC application

**Zero Trust → Access → Applications → "Productive MCP"** (SaaS, OIDC): Google only, policy "Functn Team", PKCE on, scopes `openid email profile offline_access`, redirect URL `https://productive-mcp.functn.com/oauth/access/callback`. Its issuer and client ID are text bindings (`ACCESS_ISSUER`, `ACCESS_CLIENT_ID`); the client secret is the Worker secret `ACCESS_CLIENT_SECRET`.

### 3. apps.functn.com

- The caller `productive-mcp` in functn-apps `src/connections/callers.ts` names this server's app (`app: "productive"`) and the Access for SaaS client ID; it may call Productive as the person (`*`) and as `productive-bot` (`GET people`, `GET custom_roles`).
- People get a role in app `productive` on apps.functn.com and connect their own Productive token there.

### 3. Set Worker secrets

1Password is the source of truth: the item `productive-mcp` in vault `Infra - L7` holds every value
(secrets and config), one field per variable. `.env.tpl` lists the two secrets as `op://`
references. Change a secret in 1Password, then push it:

```sh
for name in ACCESS_CLIENT_SECRET COOKIE_ENCRYPTION_KEY; do
  bunx cf workers secrets update "$name" --worker productive-mcp \
    --text "$(op read "op://Infra - L7/productive-mcp/$name")"
done
```

`COOKIE_ENCRYPTION_KEY` is `openssl rand -hex 32`; it encrypts attachment download links.

## Local development

Secrets live in 1Password (vault `Infra - L7`, item `productive-mcp`). `.env.tpl` lists the secrets as `op://` references; write `.env` from it, then:

```sh
op inject -f -i .env.tpl -o .env
npm install
npm run dev      # cf dev
```

A real Access for SaaS app is still required for the OAuth dance to work locally. Either add `http://localhost:8787/oauth/access/callback` as a redirect URL on your existing app, or create a separate dev app. Tools also need apps.functn.com's `Access` and `Connections` bindings, which `cf dev` reaches only with a local apps.functn.com.

## Deploying

Every push to `main` deploys through the GitHub Actions workflow `deploy.yml` (typecheck, tests, then
`bun run deploy` = `cf deploy`); pull requests run the same checks in `ci.yml`. The repo secret
`CF_API_TOKEN` (the shared Functn deploy token, see monitoring.functn.com `docs/secret-management.md`)
must be set. Config is in `cloudflare.config.ts`. Manual deploy from a laptop: `bun run deploy`.

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
