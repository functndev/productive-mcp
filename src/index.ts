import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { handleAccessRequest, recheckOnRefresh } from "./access-handler.js";
import { allowedRegistration, isAllowedRedirectUri } from "./clients.js";
import type { Props } from "./workers-oauth-utils.js";
import { createMcpServer } from "./mcp.js";
import { parseConfig, type Config } from "./config/index.js";
import {
  ATTACHMENT_PATH_PREFIX,
  createAttachmentLinkSigner,
  handleAttachmentDownload,
} from "./attachment-links.js";

/**
 * The protected MCP endpoint. Stateless: every request builds a fresh McpServer for the
 * authenticated user from the grant props, so nothing outlives the request.
 */
function handleMcpRequest(request: Request, env: Env, props: Props): Promise<Response> {
  const config: Config = parseConfig({
    // Per-user API token resolved from USER_MAPPING by the Access middleware.
    PRODUCTIVE_API_TOKEN: props.productiveApiToken,
    PRODUCTIVE_USER_ID: props.productiveUserId,
    PRODUCTIVE_USER_EMAIL: props.email,
    PRODUCTIVE_ORG_ID: (env as Env & { PRODUCTIVE_ORG_ID?: string }).PRODUCTIVE_ORG_ID,
    PRODUCTIVE_API_BASE_URL: env.PRODUCTIVE_API_BASE_URL,
    // Admin token resolved from any USER_MAPPING entry flagged isAdmin:true.
    // Only used by tools that need elevated access (e.g. list_users).
    PRODUCTIVE_ADMIN_API_TOKEN: props.adminApiToken,
  });

  // The Worker's hostname is not in the config, so use the one the client connected to;
  // get_attachment builds download links from it.
  const origin = new URL(request.url).origin;
  const attachmentLinks = config.PRODUCTIVE_USER_ID
    ? createAttachmentLinkSigner(origin, env.COOKIE_ENCRYPTION_KEY, config.PRODUCTIVE_USER_ID)
    : undefined;

  return createMcpHandler(() => createMcpServer(config, attachmentLinks)).fetch(request);
}

const DAY = 24 * 60 * 60;

/** Routes outside /mcp: sign-in, consent and signed attachment downloads. */
const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    // Signed attachment links authenticate themselves, so they bypass OAuth.
    if (url.pathname.startsWith(ATTACHMENT_PATH_PREFIX)) {
      return handleAttachmentDownload(request, env);
    }
    // Tokens only ever go to Claude or a local client (see clients.ts). Checked here too, not only
    // at registration, because clients registered before the allowlist are still stored.
    const redirectUri = url.searchParams.get("redirect_uri");
    if (url.pathname === "/authorize" && redirectUri && !isAllowedRedirectUri(redirectUri)) {
      return new Response("This MCP server only signs in Claude and local MCP clients.", { status: 400 });
    }
    return handleAccessRequest(request, env as never, ctx);
  },
};

// Options depend on env (PUBLIC_URL), so the provider is built on first use per isolate.
let provider: OAuthProvider<Env> | undefined;

function getProvider(env: Env): OAuthProvider<Env> {
  provider ??= new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: {
      fetch(request: Request, env: Env, ctx: ExecutionContext<Props>) {
        return handleMcpRequest(request, env, ctx.props);
      },
    } as never,
    defaultHandler: defaultHandler as ExportedHandler<Env>,
    // Paths as before the 1.x upgrade: registered clients and their metadata point at them.
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    // Claude uses Client ID Metadata Documents when offered and falls back to dynamic registration.
    clientIdMetadataDocumentEnabled: true,
    // Must equal the resource existing grants carry (checked 2026-10-12: all ".../mcp"), or every
    // session breaks on the upgrade from 0.x.
    resourceMetadata: {
      resource: new URL("/mcp", env.PUBLIC_URL).toString(),
      authorization_servers: [new URL(env.PUBLIC_URL).origin],
      resource_name: "Productive",
    },
    // Short-lived: every refresh re-checks USER_MAPPING and Cloudflare Access (recheckOnRefresh),
    // so 15 minutes is the longest anyone keeps access after being removed.
    accessTokenTTL: 15 * 60,
    // Grants stay alive while used; an idle month means signing in again.
    refreshTokenIdleTTL: 30 * DAY,
    refreshTokenTTL: 180 * DAY,
    // Only Claude's callbacks and loopback clients may register (see clients.ts).
    clientRegistrationCallback: ({ clientMetadata }) =>
      allowedRegistration(clientMetadata)
        ? undefined
        : { code: "invalid_redirect_uri", description: "Only Claude and local MCP clients may register with this server." },
    tokenExchangeCallback: recheckOnRefresh,
  });
  return provider;
}

export default {
  fetch(request, env, ctx) {
    return getProvider(env).fetch(request, env, ctx);
  },

  // Daily sweep of expired OAuth records, resuming where the previous run stopped.
  async scheduled(_controller, env) {
    const cursor = (await env.OAUTH_KV.get("purge-cursor")) ?? undefined;
    const result = await getProvider(env).purgeExpiredData(env, { batchSize: 100, cursor });
    if (result.cursor) await env.OAUTH_KV.put("purge-cursor", result.cursor);
    else await env.OAUTH_KV.delete("purge-cursor");
  },
} satisfies ExportedHandler<Env>;
