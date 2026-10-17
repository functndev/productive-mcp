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

      PRODUCTIVE_API_BASE_URL: bindings.text("https://api.productive.io/api/v2/"),
      // Canonical origin: the OAuth resource is <PUBLIC_URL>/mcp.
      PUBLIC_URL: bindings.text("https://productive-mcp.functn.com"),
      // Productive.io organization ID (`X-Organization-Id` header).
      PRODUCTIVE_ORG_ID: bindings.text("3591"),
      // Cloudflare Access SaaS app "Productive MCP" → OIDC. Not secret: the client ID shows up in
      // every login redirect.
      ACCESS_CLIENT_ID: bindings.text(
        "4ed17bf00f728c7cc917d0701e6278eb3dbbf310d280862f394f985d0ad2d208",
      ),
      ACCESS_AUTHORIZATION_URL: bindings.text(
        "https://functn.cloudflareaccess.com/cdn-cgi/access/sso/oidc/4ed17bf00f728c7cc917d0701e6278eb3dbbf310d280862f394f985d0ad2d208/authorization",
      ),
      ACCESS_TOKEN_URL: bindings.text(
        "https://functn.cloudflareaccess.com/cdn-cgi/access/sso/oidc/4ed17bf00f728c7cc917d0701e6278eb3dbbf310d280862f394f985d0ad2d208/token",
      ),
      ACCESS_JWKS_URL: bindings.text(
        "https://functn.cloudflareaccess.com/cdn-cgi/access/sso/oidc/4ed17bf00f728c7cc917d0701e6278eb3dbbf310d280862f394f985d0ad2d208/jwks",
      ),

      // Secrets: values in 1Password (Infra - L7 / productive-mcp), see .env.tpl.
      // JSON keyed by lowercased email: {"alice@example.com":{"userId":123,"apiToken":"...","isAdmin":true}}
      USER_MAPPING: bindings.secret(),
      // Cloudflare Access SaaS app OIDC client secret.
      ACCESS_CLIENT_SECRET: bindings.secret(),
      // Encrypts the OAuth approval cookie (`openssl rand -hex 32`).
      COOKIE_ENCRYPTION_KEY: bindings.secret(),
    },
  },
});
