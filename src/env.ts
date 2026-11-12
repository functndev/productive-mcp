import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Actor } from "./lib/log.js";
import type { OidcClientConfig } from "./oidc.js";

/** Bindings from cloudflare.config.ts plus the helpers the OAuth provider injects. */
export type AppEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

/**
 * Props stored (encrypted per token by the OAuth provider) in each MCP grant: exactly what
 * functn-it's mcp/ convention allows, and no Productive credential.
 */
export interface GrantProps {
  /** The Access email, lower-cased at sign-in. */
  email: Actor;
  /**
   * The person's grant from apps.functn.com (a signed JWT with their roles, 10 minutes), issued at
   * sign-in and renewed on every MCP token refresh, verified on every MCP request (src/access.ts).
   * Grants from before it have none: their requests answer 401 until the client refreshes.
   */
  grant?: string;
  /** Cloudflare Access refresh token: used on every MCP token refresh to re-check the Access policy. */
  accessRefreshToken?: string;
  /**
   * Fallback when Access issued no refresh token: the grant can't be re-checked, so it may only be
   * refreshed until this time (epoch ms), then the user signs in through Access again.
   */
  reauthBy?: number;
  /**
   * The person's own Access for SaaS ID token (`aud` = our client id), renewed with every MCP token
   * refresh. apps.functn.com Connections takes it on every Productive call instead of an email, and
   * answers with the person's own Productive token. Not the access token: its `aud` is not the
   * client id, so apps.functn.com refuses it.
   */
  idToken?: string;
  /** When idToken expires (epoch ms). */
  idTokenExpiresAt?: number;
}

/** Cloudflare Access returns here after signing a person in (functn-it mcp/, fixed paths). */
export const ACCESS_CALLBACK_PATH = "/oauth/access/callback";

export function accessClient(env: Env): OidcClientConfig {
  return {
    issuer: env.ACCESS_ISSUER,
    clientId: env.ACCESS_CLIENT_ID,
    clientSecret: env.ACCESS_CLIENT_SECRET,
    redirectUri: new URL(ACCESS_CALLBACK_PATH, env.PUBLIC_URL).toString(),
  };
}
