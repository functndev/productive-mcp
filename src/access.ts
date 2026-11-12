// Who may use the Productive MCP, with which roles: decided on apps.functn.com (People page). It
// answers with a signed grant (10 minutes) for the person's own Access for SaaS ID token: issued at
// sign-in, renewed on every MCP token refresh and kept in the MCP grant props, verified locally on
// every MCP request without calling apps.functn.com (functn-apps docs/authorization.md,
// src/apps-functn-com/grant-client.ts).

import { mcpGrant } from "./apps-functn-com/grant-client.js";
import type { GrantClaims, Refused } from "./apps-functn-com/grant-client.js";

/**
 * This server's app id in apps.functn.com's catalog. Proposed, not in the catalog yet: the
 * `productive-mcp` caller in functn-apps src/connections/callers.ts needs `app: "productive"`.
 */
export const APP_ID = "productive";

export const productiveGrants = (env: Env) =>
  mcpGrant({ binding: env.ACCESS, app: APP_ID, publicKeys: env.GRANT_PUBLIC_KEYS });

/**
 * What a person may do here. `reader` only reads; `editor` also creates and changes records. What
 * they may see and change in Productive itself is still their own Productive token's business.
 */
export type Role = "reader" | "editor";

const RANK: Record<Role, number> = { reader: 0, editor: 1 };

/**
 * The role the server checks, from the grant's roles (several are possible, in no particular
 * order): the highest one it knows. `admin` counts as editor; roles this server doesn't know (yet)
 * count as the least, reader.
 */
export function roleFrom(roles: ReadonlyArray<string>): Role {
  if (roles.includes("editor") || roles.includes("admin")) return "editor";
  return "reader";
}

/** Whether `role` reaches a tool that needs `minimum`. */
export const reaches = (role: Role, minimum: Role) => RANK[role] >= RANK[minimum];

/** apps.functn.com could not be reached: retry rather than revoke. */
export const isUnavailable = (refused: Refused) => refused.error === "temporarily_unavailable";

/**
 * apps.functn.com calls our exchange request a caller bug: our configuration (the app id, the
 * caller's `app`, the Access app), not the person. An `error`, never "no access" (functn-it errors/ D6).
 */
export const isMisconfigured = (refused: Refused) =>
  refused.error === "invalid_client" ||
  refused.error === "invalid_request" ||
  refused.error === "invalid_target" ||
  refused.error === "unsupported_grant_type";

/** apps.functn.com's own reason, with where to ask for access. */
export const refusalMessage = (refused: Refused) =>
  isUnavailable(refused) ? refused.error_description : `${refused.error_description} (${refused.appsUrl})`;

/** A missing ID token is a refusal of its own, before asking apps.functn.com. */
export const noIdToken = (): Refused => ({
  ok: false,
  error: "invalid_grant",
  error_description: "Cloudflare Access returned no ID token to check access with",
  appsUrl: "https://apps.functn.com",
});

export type { GrantClaims, Refused };
