import { McpAgent } from "agents/mcp";
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";
import { createMcpServer } from "./mcp.js";
import { parseConfig, type Config } from "./config/index.js";

/**
 * Per-user record stored in the USER_MAPPING secret.
 */
interface UserEntry {
  userId: string | number;
  apiToken: string;
}

/**
 * Shape of the USER_MAPPING secret:
 *   {
 *     "alice@example.com": { "userId": 123, "apiToken": "..." },
 *     "bob@example.com":   { "userId": 456, "apiToken": "..." }
 *   }
 *
 * Set with:
 *   wrangler secret put USER_MAPPING < users.json
 */
type UserMapping = Record<string, UserEntry>;

interface AuthContext extends Record<string, unknown> {
  email: string;
  sub: string;
  productiveUserId: string;
  productiveApiToken: string;
}

/**
 * Per-request props made available to the McpAgent instance via ctx.props.
 * The agents runtime serializes these into the Durable Object session.
 */
type Props = AuthContext;

function parseUserMapping(raw: string | undefined): UserMapping {
  if (!raw) {
    throw new Error("USER_MAPPING secret is not set");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `USER_MAPPING is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("USER_MAPPING must be a JSON object keyed by email");
  }
  return parsed as UserMapping;
}

export class ProductiveMcp extends McpAgent<Env, unknown, Props> {
  // Assigned in init(). Typed loosely to accommodate the low-level Server.
  // biome-ignore lint/suspicious/noExplicitAny: agents SDK accepts Server | McpServer
  server: any;

  async init() {
    const env = this.env as Env & {
      PRODUCTIVE_ORG_ID?: string;
    };
    const config: Config = parseConfig({
      // Per-user values resolved from the validated Access JWT + USER_MAPPING.
      PRODUCTIVE_API_TOKEN: this.props?.productiveApiToken,
      PRODUCTIVE_USER_ID: this.props?.productiveUserId,
      PRODUCTIVE_ORG_ID: env.PRODUCTIVE_ORG_ID,
      PRODUCTIVE_API_BASE_URL: env.PRODUCTIVE_API_BASE_URL,
    });

    this.server = createMcpServer(config);
  }
}

/**
 * Cache the JWKS resolver per TEAM_DOMAIN. createRemoteJWKSet handles its own
 * caching of the fetched keys, so we just keep a single instance per worker.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(teamDomain: string) {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

/**
 * Verify the Access JWT against the team's public keys and return the payload.
 * https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
 */
async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  policyAud: string,
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, getJwks(teamDomain), {
    issuer: teamDomain,
    audience: policyAud,
  });
  return payload;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    const isMcp = url.pathname === "/mcp";
    const isSse = url.pathname === "/sse" || url.pathname === "/sse/message";
    if (!isMcp && !isSse) {
      return new Response("Not found", { status: 404 });
    }

    const e = env as Env & {
      TEAM_DOMAIN?: string;
      POLICY_AUD?: string;
      USER_MAPPING?: string;
    };

    if (!e.TEAM_DOMAIN || !e.POLICY_AUD) {
      console.error("TEAM_DOMAIN or POLICY_AUD is not configured");
      return new Response("Server misconfigured", { status: 500 });
    }

    let mapping: UserMapping;
    try {
      mapping = parseUserMapping(e.USER_MAPPING);
    } catch (err) {
      console.error("USER_MAPPING configuration error:", err);
      return new Response("Server misconfigured", { status: 500 });
    }

    // 1. Verify the Cloudflare Access JWT.
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) {
      return new Response("Unauthorized: missing Cf-Access-Jwt-Assertion", {
        status: 401,
      });
    }

    let payload: JWTPayload;
    try {
      payload = await verifyAccessJwt(token, e.TEAM_DOMAIN, e.POLICY_AUD);
    } catch (err) {
      console.warn("Access JWT verification failed:", err);
      return new Response("Forbidden: invalid Access token", { status: 403 });
    }

    const email = typeof payload.email === "string" ? payload.email : undefined;
    const sub = typeof payload.sub === "string" ? payload.sub : "unknown";
    if (!email) {
      return new Response("Forbidden: token has no email claim", { status: 403 });
    }

    // 2. Look up the verified email in USER_MAPPING.
    const normalizedEmail = email.toLowerCase();
    const entry = mapping[normalizedEmail] ?? mapping[email];
    if (!entry || !entry.apiToken || entry.userId === undefined) {
      return new Response(
        `Forbidden: ${email} is not authorized to use this MCP server`,
        { status: 403 },
      );
    }

    // 3. Pass auth context through to the McpAgent via ctx.props.
    const props: Props = {
      email: normalizedEmail,
      sub,
      productiveUserId: String(entry.userId),
      productiveApiToken: entry.apiToken,
    };
    (ctx as unknown as { props: Props }).props = props;

    if (isMcp) {
      return ProductiveMcp.serve("/mcp").fetch(request, env, ctx);
    }
    return ProductiveMcp.serveSSE("/sse").fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
