import { Buffer } from "node:buffer";
import {
  OAuthError as ProviderOAuthError,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import {
  createOAuthState,
  fetchUpstreamAuthToken,
  getUpstreamAuthorizeUrl,
  OAuthError,
  type Props,
  validateOAuthState,
} from "./workers-oauth-utils.js";

type EnvWithOauth = Env & { OAUTH_PROVIDER: OAuthHelpers };

/** How long a grant may live when Access issued no refresh token to re-check it with. */
const REAUTH_WITHOUT_REFRESH_MS = 24 * 60 * 60 * 1000;

/** Per-user record stored in the USER_MAPPING secret. */
export interface UserEntry {
  userId: string | number;
  apiToken: string;
  isAdmin?: boolean;
}
type UserMapping = Record<string, UserEntry>;

export function parseUserMapping(raw: string | undefined): UserMapping {
  if (!raw) throw new Error("USER_MAPPING secret is not set");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `USER_MAPPING is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
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
): {
  productiveUserId: string;
  productiveApiToken: string;
} | null {
  const normalizedEmail = email.toLowerCase();
  const entry = mapping[normalizedEmail] ?? mapping[email];
  if (!entry || !entry.apiToken || entry.userId === undefined) return null;
  return {
    productiveUserId: String(entry.userId),
    productiveApiToken: entry.apiToken,
  };
}

/** Find the API token of any user flagged as `isAdmin: true` in USER_MAPPING. */
function findAdminApiToken(mapping: UserMapping): string | null {
  for (const entry of Object.values(mapping)) {
    if (entry?.isAdmin === true && entry.apiToken) return entry.apiToken;
  }
  return null;
}

export async function handleAccessRequest(
  request: Request,
  env: EnvWithOauth,
  _ctx: ExecutionContext,
) {
  const { pathname, searchParams } = new URL(request.url);

  // No page of our own and no consent step: straight on to Cloudflare Access (Google only). Consent
  // would only guard against unknown apps receiving tokens; index.ts already limits that to Claude's
  // callbacks and local clients (clients.ts).
  if (request.method === "GET" && pathname === "/authorize") {
    const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    if (!oauthReqInfo.clientId) return new Response("Invalid request", { status: 400 });
    const { stateToken, codeChallenge } = await createOAuthState(
      oauthReqInfo,
      env.OAUTH_KV,
      env.COOKIE_ENCRYPTION_KEY,
    );
    return redirectToAccess(request, env, stateToken, codeChallenge);
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

    const upstream = await fetchUpstreamAuthToken({
      client_id: env.ACCESS_CLIENT_ID,
      client_secret: env.ACCESS_CLIENT_SECRET,
      code: searchParams.get("code") ?? undefined,
      redirect_uri: new URL("/callback", request.url).href,
      upstream_url: env.ACCESS_TOKEN_URL,
      code_verifier: codeVerifier,
    });
    if (upstream.error) return upstream.error;
    const { accessToken, idToken, refreshToken } = upstream;

    const idTokenClaims = await verifyToken(env, idToken);
    const email = String(idTokenClaims.email ?? "");
    const name = String(idTokenClaims.name ?? "");
    const sub = String(idTokenClaims.sub ?? "");

    if (!email) {
      return new Response("Forbidden: ID token has no email claim", {
        status: 403,
      });
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

    // Without a refresh token the Access policy can't be re-checked on refresh (see
    // recheckOnRefresh), so the grant then only lives for a day.
    if (!refreshToken) {
      console.warn(`Cloudflare Access issued no refresh token for ${email}; grant limited to 24h`);
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
        adminApiToken: findAdminApiToken(mapping) ?? undefined,
        ...(refreshToken
          ? { accessRefreshToken: refreshToken }
          : { reauthBy: Date.now() + REAUTH_WITHOUT_REFRESH_MS }),
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
      // offline_access: the conventional OIDC way to ask for a refresh token.
      scope: "openid email profile offline_access",
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
  // Every Access app in the team signs with the same keys: only accept tokens issued to ours.
  const audiences: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(env.ACCESS_CLIENT_ID)) throw new Error("ID token was not issued to this app");
  return claims;
}

/**
 * On every MCP token refresh (tokenExchangeCallback): re-read USER_MAPPING, so removed users lose
 * access and rotated Productive tokens take effect, and refresh the user's Cloudflare Access token,
 * which re-evaluates the Access policy. Throwing invalid_grant revokes the grant; the client then
 * signs in again.
 */
export async function recheckOnRefresh({
  grantType,
  props,
  env,
}: {
  grantType: string;
  props: unknown;
  env: Env;
}): Promise<{ newProps: Props } | undefined> {
  if (grantType !== "refresh_token") return undefined;
  const current = props as Props;
  const signInAgain = (description: string) =>
    new ProviderOAuthError("invalid_grant", { description });

  const mapping = parseUserMapping(env.USER_MAPPING);
  const productive = lookupProductiveCredentials(current.email, mapping);
  if (!productive) throw signInAgain(`${current.email} is no longer allowed to use this server`);
  const next: Props = {
    ...current,
    productiveUserId: productive.productiveUserId,
    productiveApiToken: productive.productiveApiToken,
    adminApiToken: findAdminApiToken(mapping) ?? undefined,
  };

  if (!current.accessRefreshToken) {
    // Grants from before this check carry neither field: they get the same day as a grant whose
    // sign-in returned no refresh token, so everyone signs in again at most once.
    const reauthBy = current.reauthBy ?? Date.now() + REAUTH_WITHOUT_REFRESH_MS;
    if (Date.now() >= reauthBy) throw signInAgain("Sign in through Cloudflare Access again");
    return { newProps: { ...next, reauthBy } };
  }

  let response: Response;
  try {
    response = await fetch(env.ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.accessRefreshToken,
        client_id: env.ACCESS_CLIENT_ID,
        client_secret: env.ACCESS_CLIENT_SECRET,
      }).toString(),
    });
  } catch {
    // Access unreachable: keep the grant, let the client retry.
    throw new ProviderOAuthError("temporarily_unavailable", {
      description: "Cloudflare Access is unavailable",
      statusCode: 503,
    });
  }
  if (response.status >= 400 && response.status < 500) {
    console.warn(`Access refresh denied for ${current.email}: ${response.status}`);
    throw signInAgain("Cloudflare Access no longer allows this user");
  }
  if (!response.ok) {
    throw new ProviderOAuthError("temporarily_unavailable", {
      description: "Cloudflare Access is unavailable",
      statusCode: 503,
    });
  }
  const body = (await response.json()) as { refresh_token?: string };
  console.log(
    `Token refresh for ${current.email}: Cloudflare Access re-check passed${body.refresh_token ? " (refresh token rotated)" : ""}`,
  );
  return {
    newProps: { ...next, accessRefreshToken: body.refresh_token ?? current.accessRefreshToken },
  };
}
