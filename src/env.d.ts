// Augments the generated `Env` interface (worker-configuration.d.ts) with the secrets, which
// wrangler can't infer from `wrangler.jsonc`. Plain config lives in `wrangler.jsonc` vars.
//
// Values come from 1Password (see `.env.tpl`); production gets them as Worker secrets.
declare namespace Cloudflare {
  interface Env {
    /**
     * JSON object keyed by lowercased email:
     *   { "alice@example.com": { "userId": 123, "apiToken": "..." } }
     */
    USER_MAPPING: string;

    /** Cloudflare Access for SaaS OAuth client secret. */
    ACCESS_CLIENT_SECRET: string;

    /** Random key used to sign cookies (e.g. `openssl rand -hex 32`). */
    COOKIE_ENCRYPTION_KEY: string;
  }
}

// Newer `wrangler types` declares the global `Env` apart from `Cloudflare.Env`; make it see the
// secrets above too.
interface Env extends Cloudflare.Env {}
