import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { handleAccessRequest } from "./access-handler.js";
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

export default new OAuthProvider({
  apiHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext<Props>) {
      return handleMcpRequest(request, env, ctx.props);
    },
  } as never,
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      // Signed attachment links authenticate themselves, so they bypass OAuth.
      if (new URL(request.url).pathname.startsWith(ATTACHMENT_PATH_PREFIX)) {
        return handleAttachmentDownload(request, env);
      }
      return handleAccessRequest(request, env as never, ctx);
    },
  },
  tokenEndpoint: "/token",
});
