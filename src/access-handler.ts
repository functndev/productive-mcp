import { Buffer } from "node:buffer";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import {
  addApprovedClient,
  createOAuthState,
  fetchUpstreamAuthToken,
  generateCSRFProtection,
  getUpstreamAuthorizeUrl,
  isClientApproved,
  OAuthError,
  type Props,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./workers-oauth-utils.js";

type EnvWithOauth = Env & { OAUTH_PROVIDER: OAuthHelpers };

/** Per-user record stored in the USER_MAPPING secret. */
interface UserEntry {
  userId: string | number;
  apiToken: string;
}
type UserMapping = Record<string, UserEntry>;

function parseUserMapping(raw: string | undefined): UserMapping {
  if (!raw) throw new Error("USER_MAPPING secret is not set");
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

function lookupProductiveCredentials(
  email: string,
  mapping: UserMapping,
): { productiveUserId: string; productiveApiToken: string } | null {
  const normalizedEmail = email.toLowerCase();
  const entry = mapping[normalizedEmail] ?? mapping[email];
  if (!entry || !entry.apiToken || entry.userId === undefined) return null;
  return {
    productiveUserId: String(entry.userId),
    productiveApiToken: entry.apiToken,
  };
}

export async function handleAccessRequest(
  request: Request,
  env: EnvWithOauth,
  _ctx: ExecutionContext,
) {
  const { pathname, searchParams } = new URL(request.url);

  if (request.method === "GET" && pathname === "/authorize") {
    const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const { clientId } = oauthReqInfo;
    if (!clientId) return new Response("Invalid request", { status: 400 });

    if (await isClientApproved(request, clientId, env.COOKIE_ENCRYPTION_KEY)) {
      const { stateToken, codeChallenge } = await createOAuthState(
        oauthReqInfo,
        env.OAUTH_KV,
        env.COOKIE_ENCRYPTION_KEY,
      );
      return redirectToAccess(request, env, stateToken, codeChallenge);
    }

    const { token: csrfToken, setCookie } = generateCSRFProtection();
    return renderApprovalDialog(request, {
      client: await env.OAUTH_PROVIDER.lookupClient(clientId),
      csrfToken,
      server: {
        description:
          "Remote MCP server for Productive.io, secured by Cloudflare Access.",
        logo: "https://avatars.githubusercontent.com/u/314135?s=200&v=4",
        name: "Productive MCP Server",
      },
      setCookie,
      state: { oauthReqInfo },
    });
  }

  if (request.method === "POST" && pathname === "/authorize") {
    try {
      const formData = await request.formData();
      const csrfResult = validateCSRFToken(formData, request);

      const encodedState = formData.get("state");
      if (!encodedState || typeof encodedState !== "string") {
        return new Response("Missing state in form data", { status: 400 });
      }

      let state: { oauthReqInfo?: AuthRequest };
      try {
        state = JSON.parse(atob(encodedState));
      } catch {
        return new Response("Invalid state data", { status: 400 });
      }

      if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
        return new Response("Invalid request", { status: 400 });
      }

      const approvedClientCookie = await addApprovedClient(
        request,
        state.oauthReqInfo.clientId,
        env.COOKIE_ENCRYPTION_KEY,
      );
      const { stateToken, codeChallenge } = await createOAuthState(
        state.oauthReqInfo,
        env.OAUTH_KV,
        env.COOKIE_ENCRYPTION_KEY,
      );

      const redirectHeaders = new Headers();
      redirectHeaders.append("Set-Cookie", approvedClientCookie);
      redirectHeaders.append("Set-Cookie", csrfResult.clearCookie);

      return redirectToAccess(request, env, stateToken, codeChallenge, redirectHeaders);
    } catch (error: any) {
      console.error("POST /authorize error:", error);
      if (error instanceof OAuthError) return error.toResponse();
      return new Response(`Internal server error: ${error.message}`, { status: 500 });
    }
  }

  if (request.method === "GET" && pathname === "/callback") {
    let oauthReqInfo: AuthRequest;
    let codeVerifier: string;
    try {
      const result = await validateOAuthState(
        request,
        env.OAUTH_KV,
        env.COOKIE_ENCRYPTION_KEY,
      );
      oauthReqInfo = result.oauthReqInfo;
      codeVerifier = result.codeVerifier;
    } catch (error: any) {
      if (error instanceof OAuthError) return error.toResponse();
      return new Response("Internal server error", { status: 500 });
    }

    if (!oauthReqInfo.clientId) {
      return new Response("Invalid OAuth request data", { status: 400 });
    }

    const [accessToken, idToken, errResponse] = await fetchUpstreamAuthToken({
      client_id: env.ACCESS_CLIENT_ID,
      client_secret: env.ACCESS_CLIENT_SECRET,
      code: searchParams.get("code") ?? undefined,
      redirect_uri: new URL("/callback", request.url).href,
      upstream_url: env.ACCESS_TOKEN_URL,
      code_verifier: codeVerifier,
    });
    if (errResponse) return errResponse;

    const idTokenClaims = await verifyToken(env, idToken);
    const email = String(idTokenClaims.email ?? "");
    const name = String(idTokenClaims.name ?? "");
    const sub = String(idTokenClaims.sub ?? "");

    if (!email) {
      return new Response("Forbidden: ID token has no email claim", { status: 403 });
    }

    // Resolve Productive credentials for this user.
    let mapping: UserMapping;
    try {
      mapping = parseUserMapping(env.USER_MAPPING);
    } catch (err) {
      console.error("USER_MAPPING configuration error:", err);
      return new Response("Server misconfigured", { status: 500 });
    }

    const productive = lookupProductiveCredentials(email, mapping);
    if (!productive) {
      return new Response(
        `Forbidden: ${email} is not authorized to use this MCP server`,
        { status: 403 },
      );
    }

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      metadata: { label: name || email },
      props: {
        accessToken,
        email,
        login: sub,
        name,
        productiveUserId: productive.productiveUserId,
        productiveApiToken: productive.productiveApiToken,
      } as Props,
      request: oauthReqInfo,
      scope: oauthReqInfo.scope,
      userId: sub,
    });

    return Response.redirect(redirectTo, 302);
  }

  return new Response("Not Found", { status: 404 });
}

async function redirectToAccess(
  request: Request,
  env: Env,
  stateToken: string,
  codeChallenge: string,
  extraHeaders: Headers = new Headers(),
) {
  const headers = new Headers(extraHeaders);
  headers.set(
    "location",
    getUpstreamAuthorizeUrl({
      client_id: env.ACCESS_CLIENT_ID,
      code_challenge: codeChallenge,
      redirect_uri: new URL("/callback", request.url).href,
      scope: "openid email profile",
      state: stateToken,
      upstream_url: env.ACCESS_AUTHORIZATION_URL,
    }),
  );
  return new Response(null, { headers, status: 302 });
}

/** Fetch the Access JWKS public key for a given key id. */
async function fetchAccessPublicKey(env: Env, kid: string) {
  if (!env.ACCESS_JWKS_URL) throw new Error("access jwks url not provided");
  const resp = await fetch(env.ACCESS_JWKS_URL);
  const keys = (await resp.json()) as {
    keys: (JsonWebKey & { kid: string })[];
  };
  const jwk = keys.keys.filter((key) => key.kid === kid)[0];
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["verify"],
  );
}

function parseJWT(token: string) {
  const tokenParts = token.split(".");
  if (tokenParts.length !== 3) throw new Error("token must have 3 parts");
  return {
    data: `${tokenParts[0]}.${tokenParts[1]}`,
    header: JSON.parse(Buffer.from(tokenParts[0], "base64url").toString()),
    payload: JSON.parse(Buffer.from(tokenParts[1], "base64url").toString()),
    signature: tokenParts[2],
  };
}

async function verifyToken(env: Env, token: string) {
  const jwt = parseJWT(token);
  const key = await fetchAccessPublicKey(env, jwt.header.kid);
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Buffer.from(jwt.signature, "base64url"),
    Buffer.from(jwt.data),
  );
  if (!verified) throw new Error("failed to verify token");

  const claims = jwt.payload;
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) throw new Error("expired token");
  return claims;
}
