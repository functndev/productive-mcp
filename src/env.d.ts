// Augments the generated `Env` interface (worker-configuration.d.ts) with
// secrets and bindings that wrangler can't infer from `wrangler.jsonc` alone.
//
// Set these via `wrangler secret put <NAME>` (production) or `.dev.vars` (local).
declare namespace Cloudflare {
  interface Env {
    /** Productive.io organization ID (`X-Organization-Id` header). */
    PRODUCTIVE_ORG_ID: string;

    /**
     * JSON object keyed by lowercased email:
     *   { "alice@example.com": { "userId": 123, "apiToken": "..." } }
     */
    USER_MAPPING: string;

    /** Cloudflare Access for SaaS OAuth client credentials and endpoints. */
    ACCESS_CLIENT_ID: string;
    ACCESS_CLIENT_SECRET: string;
    ACCESS_TOKEN_URL: string;
    ACCESS_AUTHORIZATION_URL: string;
    ACCESS_JWKS_URL: string;

    /** Random key used to sign cookies (e.g. `openssl rand -hex 32`). */
    COOKIE_ENCRYPTION_KEY: string;
  }
}
