import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, ProtocolError } from "@modelcontextprotocol/server";
import { handleAccessRequest, NOT_ALLOWED_CLIENT, recheckOnRefresh } from "./access-handler.js";
import { alreadyLogged } from "./answers.js";
import { errorPage, HttpError } from "./lib/http-error.js";
import { withOAuthFailures } from "./lib/oauth-failures.js";
import { allowedRegistration, isAllowedRedirectUri } from "./clients.js";
import type { Props } from "./workers-oauth-utils.js";
import { createMcpServer } from "./mcp.js";
import { log, unit } from "./lib/log.js";
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
  let config: Config;
  try {
    config = parseConfig({
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
  } catch (error) {
    // A setting of ours (PRODUCTIVE_ORG_ID, say) is missing: withOAuthFailures answers the
    // JSON-RPC error, and this is the one line.
    log.error("mcp.config_invalid", { error });
    throw alreadyLogged(
      new HttpError(503, "The Productive MCP is misconfigured on our side. Tell functn IT.", { code: "not_configured" }),
    );
  }

  // The Worker's hostname is not in the config, so use the one the client connected to;
  // get_attachment builds download links from it.
  const origin = new URL(request.url).origin;
  const attachmentLinks = config.PRODUCTIVE_USER_ID
    ? createAttachmentLinkSigner(origin, env.COOKIE_ENCRYPTION_KEY, config.PRODUCTIVE_USER_ID)
    : undefined;

  return createMcpHandler(() => createMcpServer(config, attachmentLinks), { onerror: reportMcpError }).fetch(request);
}

/** How the MCP SDK words the requests it turns away before any handler runs. */
const REJECTION = /^(Rejected |Unsupported Media Type|Not Acceptable|Method not allowed|Bad Request|Invalid Request|Parse error)/;

/**
 * The MCP SDK answers its own 500s (a factory or handler that throws outside a tool, a transport
 * failure) and only tells this callback, so this is their one `error` line. It hears of the
 * requests it rejects too (an unsupported protocol version, a bad header): those are the client's,
 * an info line.
 */
export function reportMcpError(error: Error): void {
  if (error instanceof ProtocolError || REJECTION.test(error.message)) {
    log.info("mcp.request_rejected", { reason: "protocol", description: error.message.slice(0, 300) });
    return;
  }
  log.error("mcp.request_failed", { error });
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
      log.info("mcp.sign_in_refused", { statusCode: 400, reason: "redirect_uri_not_allowed" });
      return errorPage(new HttpError(400, NOT_ALLOWED_CLIENT));
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
    // Instead of the library's plain-text "OAuth error response" warn. Refusals and failures from
    // recheckOnRefresh are already on its oauth.refresh line. A 4xx is a refusal (an expired code,
    // a revoked grant), so `info` with its status; a 5xx the library answers itself is a failure
    // of ours, so `error` (functn-it errors/README.md, D13).
    onError: ({ status, code, description, internal }) => {
      if (internal.category === "token-exchange-callback") return;
      const fields = { code, description, category: internal.category, reason: internal.reason };
      if (status < 500) {
        log.info("oauth.error_response", { statusCode: status, ...fields });
        return;
      }
      log.error("oauth.error_response", {
        httpStatus: status,
        ...fields,
        // What broke, for a callback that threw; a refusal's own OAuthError says nothing more.
        ...(internal.detail instanceof Error && !(internal.detail instanceof OAuthError) && { error: internal.detail }),
      });
    },
  });
  return provider;
}

export default {
  // The library answers OAuth's own errors and rethrows everything else (a KV outage, a bug).
  // withOAuthFailures (functn-it's recipe) logs those once and answers each caller in its format:
  // OAuth JSON on /token and /register, JSON-RPC on /mcp, a redirect back to the client once
  // /authorize or /callback has validated it, a page before that.
  fetch: withOAuthFailures((request: Request, env: Env, ctx: ExecutionContext) =>
    getProvider(env).fetch(request, env, ctx),
  ),

  // Daily sweep of expired OAuth records, resuming where the previous run stopped.
  async scheduled(_controller, env) {
    await unit("oauth.purge", { actor: "system:productive-mcp" }, async (u) => {
      const cursor = (await env.OAUTH_KV.get("purge-cursor")) ?? undefined;
      const result = await getProvider(env).purgeExpiredData(env, { batchSize: 100, cursor });
      if (result.cursor) await env.OAUTH_KV.put("purge-cursor", result.cursor);
      else await env.OAUTH_KV.delete("purge-cursor");
      u.set({
        resumed: Boolean(cursor),
        grantsChecked: result.grantsChecked,
        grantsPurged: result.grantsPurged,
        tokensChecked: result.tokensChecked,
        tokensPurged: result.tokensPurged,
        done: result.done,
      });
    });
  },
} satisfies ExportedHandler<Env>;
