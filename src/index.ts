import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { handleAccessRequest } from "./access-handler.js";
import type { Props } from "./workers-oauth-utils.js";
import { createMcpServer } from "./mcp.js";
import { parseConfig, type Config } from "./config/index.js";
import {
  ATTACHMENT_PATH_PREFIX,
  createAttachmentLinkSigner,
  handleAttachmentDownload,
} from "./attachment-links.js";

export class ProductiveMcp extends McpAgent<Env, unknown, Props> {
  // Assigned in init(). Typed loosely to accommodate the low-level Server.
  // biome-ignore lint/suspicious/noExplicitAny: agents SDK accepts Server | McpServer
  server: any;

  async init() {
    const env = this.env as Env & { PRODUCTIVE_ORG_ID?: string };
    const config: Config = parseConfig({
      // Per-user API token resolved from USER_MAPPING by the Access middleware.
      PRODUCTIVE_API_TOKEN: this.props?.productiveApiToken,
      PRODUCTIVE_USER_ID: this.props?.productiveUserId,
      PRODUCTIVE_USER_EMAIL: this.props?.email,
      PRODUCTIVE_ORG_ID: env.PRODUCTIVE_ORG_ID,
      PRODUCTIVE_API_BASE_URL: env.PRODUCTIVE_API_BASE_URL,
      // Admin token resolved from any USER_MAPPING entry flagged isAdmin:true.
      // Only used by tools that need elevated access (e.g. list_users).
      PRODUCTIVE_ADMIN_API_TOKEN: this.props?.adminApiToken,
    });

    const origin = this.props?.origin;
    const attachmentLinks =
      origin && config.PRODUCTIVE_USER_ID
        ? createAttachmentLinkSigner(origin, env.COOKIE_ENCRYPTION_KEY, config.PRODUCTIVE_USER_ID)
        : undefined;

    this.server = createMcpServer(config, attachmentLinks);
  }
}

const mcpHandler = ProductiveMcp.serve("/mcp");

export default new OAuthProvider({
  apiHandler: {
    // The Worker's hostname is not in the config, so pass on the one the
    // client connected to; get_attachment builds download links from it.
    fetch(request: Request, env: Env, ctx: ExecutionContext<Props>) {
      (ctx as { props: Props }).props = {
        ...ctx.props,
        origin: new URL(request.url).origin,
      };
      return mcpHandler.fetch(request, env, ctx);
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
