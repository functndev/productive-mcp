# Productive MCP Worker

Cloudflare Worker hosting a remote [Model Context Protocol](https://modelcontextprotocol.io/) server for the [Productive.io](https://productive.io) API, fronted by **Cloudflare Access** as a self-hosted application.

## Authentication flow

Following the
[Secure MCP servers (self-hosted)](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)
pattern, every request must carry a valid `Cf-Access-Jwt-Assertion` header issued by your Access
application. The Worker:

1. Verifies the JWT signature against your team's JWKS at `${TEAM_DOMAIN}/cdn-cgi/access/certs`,
   checking the `iss` and `aud` claims (using [`jose`](https://www.npmjs.com/package/jose)).
2. Reads the verified `email` claim from the payload.
3. Looks the email up in the `USER_MAPPING` secret
   (`{ "<email>": { "userId": <id>, "apiToken": "<token>" } }`).
4. Injects the matching `userId` and `apiToken` into the per-request MCP server config so each
   user authenticates against Productive with their own token.

Missing JWT → `401`. Invalid/expired JWT or unknown email → `403`.

## Endpoints

| Path                | Purpose                              |
| ------------------- | ------------------------------------ |
| `GET  /health`      | Liveness probe (no auth)             |
| `POST /mcp`         | Streamable HTTP MCP transport        |
| `GET  /sse`         | SSE MCP transport                    |
| `POST /sse/message` | SSE MCP message endpoint             |

## Configuration

Public vars in `wrangler.jsonc`:

| Var                       | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| `PRODUCTIVE_API_BASE_URL` | `https://api.productive.io/api/v2/`                              |
| `TEAM_DOMAIN`             | `https://<your-team-name>.cloudflareaccess.com`                  |
| `POLICY_AUD`              | AUD tag from your Access application's "Basic information" page  |

Secrets (set via Wrangler):

```sh
wrangler secret put PRODUCTIVE_ORG_ID
wrangler secret put USER_MAPPING < users.json
```

`users.json`:

```json
{
  "alice@example.com": { "userId": 123456, "apiToken": "alice-token" },
  "bob@example.com":   { "userId": 234567, "apiToken": "bob-token"   }
}
```

For local development, create `.dev.vars`:

```
PRODUCTIVE_ORG_ID=...
TEAM_DOMAIN=https://<your-team-name>.cloudflareaccess.com
POLICY_AUD=<aud-tag>
USER_MAPPING={"alice@example.com":{"userId":123456,"apiToken":"..."}}
```

## Cloudflare Access setup

1. In the Cloudflare dashboard, go to **Zero Trust → Access controls → Applications → Add an application → Self-hosted**.
2. Set the Application domain to your Worker hostname.
3. Add Access policies (e.g. allow emails ending in `@yourcompany.com`).
4. Copy the AUD tag from the application's **Basic information** and put it in `POLICY_AUD`.

## Local development

```sh
npm install
npm run dev
```

Wrangler does not inject `Cf-Access-Jwt-Assertion` locally. To exercise the auth flow during dev,
either:

- Use `cloudflared access` to tunnel through your Access application, or
- Temporarily bypass the JWT check by hitting your deployed `*.workers.dev` URL with
  [MCP Inspector](https://github.com/modelcontextprotocol/inspector) — Access will issue a real
  JWT after you log in.

## Deploying

```sh
npm run deploy
```
