import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  accountId: "e44540d8d3d22a5ebbadc5f131aeecd5", // Functn
  worker: {
    name: "productive-mcp",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    entrypoint: "src/index.ts",
    domains: ["productive-mcp.functn.com"],
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true },
    // Same as the other functn Workers: forward logs/exceptions to the central logging Worker.
    tailConsumers: [{ worker: "logging-functn-com" }],
    // Daily sweep of expired OAuth records (purgeExpiredData).
    triggers: [triggers.scheduled({ schedule: "23 3 * * *" })],
    env: {
      OAUTH_KV: bindings.kv({ id: "2d94e8819a9a41ae97f5a3bf1ecc6f61" }),

      // Productive calls go through apps.functn.com Connections (src/api/transport.ts), which adds the
      // person's own token and the organization; this is only the base the client builds URLs on.
      PRODUCTIVE_API_BASE_URL: bindings.text("https://api.productive.io/api/v2/"),
      // Canonical origin: the OAuth resource is <PUBLIC_URL>/mcp.
      PUBLIC_URL: bindings.text("https://productive-mcp.functn.com"),

      // Cloudflare Access for SaaS app "Productive MCP" (1030dd38-4944-44d7-80ad-59b5d8627130),
      // OIDC: who may sign in. Not secret: the client ID shows up in every login redirect.
      ACCESS_ISSUER: bindings.text(
        "https://functn.cloudflareaccess.com/cdn-cgi/access/sso/oidc/4ed17bf00f728c7cc917d0701e6278eb3dbbf310d280862f394f985d0ad2d208",
      ),
      ACCESS_CLIENT_ID: bindings.text(
        "4ed17bf00f728c7cc917d0701e6278eb3dbbf310d280862f394f985d0ad2d208",
      ),

      // Who may use this server, with which roles: apps.functn.com (src/access.ts). Its Access
      // entrypoint exchanges the person's Access for SaaS ID token for a signed grant, verified here
      // on every request (src/apps-functn-com/grant-client.ts). The caller needs an `app` in
      // functn-apps src/connections/callers.ts.
      ACCESS: bindings.worker({
        worker: "apps-functn-com",
        exportName: "Access",
        props: { caller: "productive-mcp" },
      }),
      // The keys grants are signed with (functn-apps cloudflare.config.ts, also at
      // https://apps.functn.com/.well-known/jwks.json). Not secret.
      GRANT_PUBLIC_KEYS: bindings.text(
        '{"keys":[{"kty":"OKP","crv":"Ed25519","x":"IWRgQKUSkmN7UpwuHmnodTst8EwjVucffrMVL98KUMk","kid":"grants-2026-10"}]}',
      ),
      // Productive as the person, with the token they connected on apps.functn.com; list_users with
      // the system credential "productive-bot" (src/apps-functn-com/connections-client.ts).
      CONNECTIONS: bindings.worker({
        worker: "apps-functn-com",
        exportName: "Connections",
        props: { caller: "productive-mcp" },
      }),

      // Secrets: values in 1Password (Infra - L7 / productive-mcp), see .env.tpl.
      // Cloudflare Access SaaS app OIDC client secret.
      ACCESS_CLIENT_SECRET: bindings.secret(),
      // Encrypts attachment download links, which carry the person's ID token
      // (src/attachment-links.ts). `openssl rand -hex 32`.
      COOKIE_ENCRYPTION_KEY: bindings.secret(),
    },
  },
});
