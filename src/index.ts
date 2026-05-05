import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { handleAccessRequest } from "./access-handler.js";
import type { Props } from "./workers-oauth-utils.js";
import { createMcpServer } from "./mcp.js";
import { parseConfig, type Config } from "./config/index.js";

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
      PRODUCTIVE_ORG_ID: env.PRODUCTIVE_ORG_ID,
      PRODUCTIVE_API_BASE_URL: env.PRODUCTIVE_API_BASE_URL,
    });

    this.server = createMcpServer(config);
  }
}

export default new OAuthProvider({
  apiHandler: ProductiveMcp.serve("/mcp") as never,
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  // biome-ignore lint/suspicious/noExplicitAny: handler signature differs from OAuthProvider's expected type
  defaultHandler: { fetch: handleAccessRequest as any },
  tokenEndpoint: "/token",
});
