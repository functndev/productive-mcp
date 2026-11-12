import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, ProtocolError } from "@modelcontextprotocol/server";
import { productiveGrants, roleFrom } from "./access.js";
import { connections } from "./apps-functn-com/connections-client.js";
import { connectionsTransport } from "./api/transport.js";
import { handleAccessCallback, handleAuthorize, MCP_SCOPE, NOT_ALLOWED_CLIENT, reCheckAccessOnRefresh } from "./authorize.js";
import { allowedRegistration, isAllowedRedirectUri } from "./clients.js";
import type { Config } from "./config/index.js";
import { ACCESS_CALLBACK_PATH, type AppEnv, type GrantProps } from "./env.js";
import { errorPage, HttpError, requestIdOf } from "./lib/http-error.js";
import { withOAuthFailures } from "./lib/oauth-failures.js";
import { log, unit, wasLogged } from "./lib/log.js";
import { createMcpServer } from "./mcp.js";
import {
  ATTACHMENT_PATH_PREFIX,
  createAttachmentLinkSigner,
  handleAttachmentDownload,
} from "./attachment-links.js";

/**
 * An ID token this close to expiring is not used for a request: Connections would refuse it
 * mid-call. The client is told to refresh instead, which renews it (authorize.ts).
 */
const ID_TOKEN_MARGIN_MS = 60_000;

/**
 * The protected MCP endpoint. Stateless: every request builds a fresh McpServer for the person,
 * with the role from their apps.functn.com grant (in the MCP grant props, renewed on every token
 * refresh, verified here on every request without calling apps.functn.com).
 */
export async function handleMcpRequest(request: Request, env: Env, props: GrantProps): Promise<Response> {
  const grant = await productiveGrants(env).verify(props, props.email);
  if (!grant.ok) {
    // A refusal: the client refreshes its token, which renews the grant or ends the session.
    log.info("mcp.request_refused", { actor: props.email, statusCode: 401, reason: grant.error, description: grant.error_description });
    return invalidToken(grant.error_description);
  }
  if (!props.idToken || (props.idTokenExpiresAt ?? 0) < Date.now() + ID_TOKEN_MARGIN_MS) {
    log.info("mcp.request_refused", { actor: props.email, statusCode: 401, reason: "id_token_expired" });
    return invalidToken("The sign-in to Productive needs renewing: refresh the access token");
  }

  const requestId = requestIdOf(request);
  const auth = { accessToken: props.idToken };
  const base = env.PRODUCTIVE_API_BASE_URL;
  const config: Config = {
    PRODUCTIVE_API_BASE_URL: base,
    PRODUCTIVE_USER_EMAIL: props.email,
    // "me" for the tools; only looked up for a tool call (it is one RPC to apps.functn.com).
    PRODUCTIVE_USER_ID: (await isToolCall(request)) ? await productivePersonId(env, auth, requestId) : undefined,
    transport: connectionsTransport(env.CONNECTIONS, auth, base, { requestId }),
    systemTransport: connectionsTransport(env.CONNECTIONS, auth, base, { requestId, systemCredential: "productive-bot" }),
  };

  // The Worker's hostname is not in the config, so use the one the client connected to;
  // get_attachment builds download links from it.
  const origin = new URL(request.url).origin;
  const attachmentLinks = createAttachmentLinkSigner(origin, env.COOKIE_ENCRYPTION_KEY, {
    email: props.email,
    idToken: props.idToken,
    idTokenExpiresAt: props.idTokenExpiresAt,
  });
  const user = { email: props.email, role: roleFrom(grant.claims.roles) };

  return createMcpHandler(() => createMcpServer(config, user, attachmentLinks), { onerror: reportMcpError }).fetch(request);
}

/** Whether the JSON-RPC body holds a tools/call (alone or in a batch). */
async function isToolCall(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  const method = request.headers.get("mcp-method");
  if (method) return method === "tools/call";
  try {
    const body = (await request.clone().json()) as unknown;
    const messages = Array.isArray(body) ? body : [body];
    return messages.some((m) => (m as { method?: unknown } | null)?.method === "tools/call");
  } catch {
    return false;
  }
}

/**
 * The person's Productive person ID from Connections' status (no call to Productive), or undefined
 * when their account isn't connected or apps.functn.com can't say: the tools then explain "me".
 */
async function productivePersonId(env: Env, auth: { accessToken: string }, requestId?: string): Promise<string | undefined> {
  try {
    const status = await connections(env.CONNECTIONS).status(auth, "productive", { requestId });
    if (status.ok) return status.account?.id;
    log.warn("mcp.connection_status_failed", { connectionsError: status.error });
  } catch (error) {
    log.warn("mcp.connection_status_failed", { error });
  }
  return undefined;
}

/** 401 with `invalid_token`, so the client refreshes (functn-it mcp/: never a 403 here). */
function invalidToken(description: string): Response {
  const quoted = description.replace(/["\\]/g, "'");
  return new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer error="invalid_token", error_description="${quoted}"`,
    },
  });
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

/** Routes outside /mcp: the sign-in and signed attachment downloads. */
const defaultHandler = {
  async fetch(request: Request, env: AppEnv) {
    const url = new URL(request.url);
    // Download links carry their own (encrypted) credential, so they bypass OAuth.
    if (url.pathname.startsWith(ATTACHMENT_PATH_PREFIX)) {
      return handleAttachmentDownload(request, env);
    }
    if (url.pathname === "/authorize") {
      // Tokens only ever go to Claude or a local client (see clients.ts). Checked on the query too,
      // before the library looks the client up.
      const redirectUri = url.searchParams.get("redirect_uri");
      if (redirectUri && !isAllowedRedirectUri(redirectUri)) {
        log.info("mcp.sign_in_refused", { statusCode: 400, reason: "redirect_uri_not_allowed" });
        return errorPage(new HttpError(400, NOT_ALLOWED_CLIENT));
      }
      return handleAuthorize(request, env);
    }
    if (url.pathname === ACCESS_CALLBACK_PATH) return handleAccessCallback(request, env);
    return new Response("Not Found", { status: 404 });
  },
};

/**
 * The OAuth paths before functn-it's mcp/ convention. Connectors added before it keep the token
 * endpoint they discovered (`/token`) for every refresh, and may register again at `/register`:
 * both are served at the new paths. `/callback` is not kept: only Cloudflare Access used it, and
 * sign-ins in flight at the switch have to start over anyway.
 */
const LEGACY_PATHS: Readonly<Record<string, string>> = {
  "/token": "/oauth/token",
  "/register": "/oauth/register",
};

function withLegacyPaths(request: Request): Request {
  const url = new URL(request.url);
  const target = LEGACY_PATHS[url.pathname];
  if (!target) return request;
  url.pathname = target;
  return new Request(url, request);
}

// Options depend on env (PUBLIC_URL), so the provider is built on first use per isolate.
let provider: OAuthProvider<AppEnv> | undefined;

function getProvider(env: AppEnv): OAuthProvider<AppEnv> {
  provider ??= new OAuthProvider<AppEnv>({
    apiRoute: "/mcp",
    apiHandler: {
      fetch(request: Request, env: Env, ctx: ExecutionContext<GrantProps>) {
        return handleMcpRequest(request, env, ctx.props);
      },
    } as never,
    defaultHandler: defaultHandler as unknown as ExportedHandler<Env>,
    // functn-it mcp/'s fixed paths (old ones: LEGACY_PATHS).
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    // Claude uses Client ID Metadata Documents when offered and falls back to dynamic registration.
    clientIdMetadataDocumentEnabled: true,
    // One scope: what a person may do comes from their role on apps.functn.com, not from scopes.
    scopesSupported: [MCP_SCOPE],
    // Must equal the resource existing grants carry (checked 2026-10-12: all ".../mcp"), or every
    // session breaks on the upgrade from 0.x.
    resourceMetadata: {
      resource: new URL("/mcp", env.PUBLIC_URL).toString(),
      authorization_servers: [new URL(env.PUBLIC_URL).origin],
      resource_name: "Productive",
    },
    // Short-lived: every refresh re-checks Cloudflare Access and renews the apps.functn.com grant
    // (reCheckAccessOnRefresh), so 10 minutes is the longest anyone keeps access after being
    // removed. At most the grant's own 10 minutes, so it is always renewed within its grace.
    accessTokenTTL: 10 * 60,
    // Grants stay alive while used; an idle month means signing in again.
    refreshTokenIdleTTL: 30 * DAY,
    refreshTokenTTL: 180 * DAY,
    // Only Claude's callbacks and loopback clients may register (see clients.ts).
    clientRegistrationCallback: ({ clientMetadata }) =>
      allowedRegistration(clientMetadata)
        ? undefined
        : { code: "invalid_redirect_uri", description: "Only Claude and local MCP clients may register with this server." },
    tokenExchangeCallback: reCheckAccessOnRefresh,
    // Instead of the library's plain-text "OAuth error response" warn. A 4xx is a refusal (an
    // expired code, a revoked grant), so `info` with its status. A 5xx is a failure with its one
    // `error` line (functn-it errors/ D6, D13), unless the code that failed wrote it already: the
    // mcp.token_refresh unit for Access or apps.functn.com unreachable (the client retries).
    onError: ({ status, code, description, internal }) => {
      const failure = status >= 500 && !wasLogged(internal?.detail);
      log[failure ? "error" : "info"]("oauth.error_response", {
        ...(status < 500 && { statusCode: status }),
        code,
        description,
        category: internal?.category,
        reason: internal?.reason,
        // What broke, for a callback that threw; a refusal's own OAuthError says nothing more.
        ...(internal?.detail instanceof Error && !(internal.detail instanceof OAuthError) && { error: internal.detail }),
      });
    },
  });
  return provider;
}

export default {
  // The library answers OAuth's own errors and rethrows everything else (a KV outage, a bug).
  // withOAuthFailures (functn-it's recipe) logs those once and answers each caller in its format:
  // OAuth JSON on /oauth/token and /oauth/register (and their old paths), JSON-RPC on /mcp, a
  // redirect back to the client once /authorize or the Access callback has validated it, a page
  // before that.
  fetch: withOAuthFailures((request: Request, env: Env, ctx: ExecutionContext) =>
    getProvider(env as AppEnv).fetch(withLegacyPaths(request), env as AppEnv, ctx),
  ),

  // Daily sweep of expired OAuth records, resuming where the previous run stopped.
  async scheduled(_controller, env) {
    await unit("oauth.purge", { actor: "system:productive-mcp" }, async (u) => {
      const cursor = (await env.OAUTH_KV.get("purge-cursor")) ?? undefined;
      const result = await getProvider(env as AppEnv).purgeExpiredData(env as AppEnv, { batchSize: 100, cursor });
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
