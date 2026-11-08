import { Buffer } from "node:buffer";
import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  OAuthError as ProviderOAuthError,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import {
  ACCESS_TIMEOUT_MS,
  type AccessTokenFailure,
  createOAuthState,
  fetchUpstreamAuthToken,
  getUpstreamAuthorizeUrl,
  type Props,
  validateOAuthState,
} from "./workers-oauth-utils.js";
import { actorOf, alreadyLogged } from "./answers.js";
import { isAllowedRedirectUri } from "./clients.js";
import { errorPage, HttpError } from "./lib/http-error.js";
import { log, type LogFields, unit } from "./lib/log.js";
import { redirectFailuresTo } from "./lib/oauth-failures.js";

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

/** What the person and Claude read when the Productive MCP's sign-in setup is broken on our side. */
const MISCONFIGURED = "Signing in to Productive is misconfigured on our side. Tell functn IT; trying again will not help.";
/** What they read when Cloudflare Access is down or failing. */
const ACCESS_DOWN = "Cloudflare Access is not answering. Try connecting to Productive again in a few minutes.";

/**
 * A sign-in failure of ours (functn-it errors/README.md, D6): its one `error` line, and the answer
 * for withOAuthFailures, which redirects it back to the client once its redirect URI is known.
 */
function signInFailed(reason: string, answer: HttpError, fields: LogFields = {}): HttpError {
  log.error("mcp.sign_in_failed", { reason, ...fields });
  return alreadyLogged(answer);
}

/**
 * Answers a request /authorize can't accept (unknown client, unregistered redirect URI, missing
 * PKCE, a Client ID Metadata Document that can't be fetched): a refusal at `info`. Back to the
 * client when the library validated its redirect URI (and it is one we sign in, clients.ts);
 * otherwise a page, because the redirect URI itself is what is untrusted. Anything else is
 * rethrown to withOAuthFailures.
 */
function authorizeRefused(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    const redirect = Boolean(error.redirectTo && error.redirectUri && isAllowedRedirectUri(error.redirectUri));
    // statusCode only when the answer is ours to give (a page); a redirect carries the error.
    log.info("mcp.sign_in_refused", {
      ...(!redirect && { statusCode: 400 }),
      reason: error.code,
      description: error.description,
      redirected: redirect,
    });
    if (redirect) return redirectResponse(error.redirectTo!);
    return errorPage(new HttpError(400, `This app's request to connect to Productive is invalid: ${error.description}`));
  }
  if (error instanceof CimdFetchError) {
    log.info("mcp.sign_in_refused", { statusCode: 400, reason: "client_metadata_unavailable", description: error.detail });
    return errorPage(new HttpError(400, "This app could not be verified, so it can't connect to Productive. Try again later."));
  }
  throw error;
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
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
    let oauthReqInfo: AuthRequest;
    try {
      oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (error) {
      return authorizeRefused(error);
    }
    // Clients registered before the allowlist are still stored, and a request may leave out
    // redirect_uri (index.ts only checks the query), so the validated one is checked here too.
    if (!isAllowedRedirectUri(oauthReqInfo.redirectUri)) {
      log.info("mcp.sign_in_refused", { statusCode: 400, reason: "redirect_uri_not_allowed" });
      return errorPage(new HttpError(400, NOT_ALLOWED_CLIENT));
    }
    // The client and its redirect URI are known from here: a failure goes back to it as
    // error=server_error (lib/oauth-failures.ts) instead of stranding the person on a page.
    redirectFailuresTo(oauthReqInfo.redirectUri, oauthReqInfo.state);
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
    } catch (error) {
      // No sign-in in progress (a reload, a link opened twice, an expired one): the person can only
      // start over, and no client can be told, so it is a page. Anything else is ours.
      if (!(error instanceof HttpError) || error.status >= 500) throw error;
      log.info("mcp.sign_in_refused", { statusCode: error.status, reason: error.reason ?? error.code });
      return errorPage(error);
    }
    redirectFailuresTo(oauthReqInfo.redirectUri, oauthReqInfo.state);

    /** A sign-in refused for the person: Claude hears access_denied and ends the connect flow. */
    const refuse = (reason: string, description: string, fields: LogFields = {}) => {
      log.info("mcp.sign_in_refused", { reason, description, redirected: true, ...fields });
      return redirectResponse(authorizationErrorRedirect(oauthReqInfo, "access_denied", description));
    };

    const code = searchParams.get("code");
    const accessError = searchParams.get("error");
    if (accessError || !code) {
      // The person cancelled at Access, or Access refused them.
      return refuse(
        "access_denied",
        `Cloudflare Access did not sign you in (${(accessError ?? "no code").slice(0, 100)}). Connect to Productive again to retry.`,
      );
    }

    const upstream = await fetchUpstreamAuthToken({
      client_id: env.ACCESS_CLIENT_ID,
      client_secret: env.ACCESS_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/callback", request.url).href,
      upstream_url: env.ACCESS_TOKEN_URL,
      code_verifier: codeVerifier,
    });
    if (!upstream.ok) throw codeExchangeFailed(upstream.failure);
    const { accessToken, idToken, refreshToken } = upstream;

    const idTokenClaims = await verifyToken(env, idToken);
    const email = String(idTokenClaims.email ?? "");
    const name = String(idTokenClaims.name ?? "");
    const sub = String(idTokenClaims.sub ?? "");

    if (!email) {
      // Access only leaves it out when its app doesn't release the email scope: ours to fix.
      throw signInFailed("no_email_claim", new HttpError(503, MISCONFIGURED, { code: "not_configured" }));
    }
    const actor = actorOf(email);

    // Resolve Productive credentials for this user.
    let mapping: UserMapping;
    try {
      mapping = parseUserMapping(env.USER_MAPPING);
    } catch (error) {
      throw signInFailed("user_mapping_invalid", new HttpError(503, MISCONFIGURED, { code: "not_configured" }), {
        actor,
        error,
      });
    }

    const productive = lookupProductiveCredentials(email, mapping);
    if (!productive) {
      return refuse(
        "not_in_user_mapping",
        `${email} is not set up to use Productive through Claude. Ask functn IT to add you.`,
        { actor },
      );
    }

    // Without a refresh token the Access policy can't be re-checked on refresh (see
    // recheckOnRefresh), so the grant then only lives for a day.
    if (!refreshToken) log.warn("mcp.no_refresh_token", { actor });

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

    log.info("audit.mcp.sign_in", {
      actor,
      clientId: oauthReqInfo.clientId,
      productivePersonId: productive.productiveUserId,
      refreshable: Boolean(refreshToken),
    });
    return redirectResponse(redirectTo);
  }

  return new Response("Not Found", { status: 404 });
}

/** Shown when a client outside clients.ts tries to sign in. */
export const NOT_ALLOWED_CLIENT = "This MCP server only signs in Claude and local MCP clients.";

/**
 * The answer for a code exchange with Access that gave no tokens, after its `error` line. The
 * person only gets here after Access signed them in, so none of these is theirs to fix: a code
 * Access refuses (400, `invalid_grant`) was used twice or took too long, which is retried by
 * connecting again; a refused client (401/403, `invalid_client`) is our ACCESS_CLIENT_SECRET.
 * Access's own description and body never reach the person.
 */
function codeExchangeFailed(failure: AccessTokenFailure): HttpError {
  switch (failure.kind) {
    case "unreachable":
      return signInFailed(
        failure.timedOut ? "access_timeout" : "access_unreachable",
        new HttpError(503, ACCESS_DOWN, { code: failure.timedOut ? "upstream_timeout" : "unavailable" }),
        { error: failure.error },
      );
    case "refused": {
      const fields = { accessStatus: failure.accessStatus, accessError: failure.accessError };
      if (failure.accessStatus >= 500) {
        return signInFailed("access_failing", new HttpError(503, ACCESS_DOWN, { code: "unavailable" }), fields);
      }
      if (failure.accessStatus === 400 && failure.accessError !== "invalid_client") {
        return signInFailed(
          "access_code_refused",
          new HttpError(500, "Cloudflare Access did not accept the sign-in. Connect to Productive again.", {
            code: "upstream_unavailable",
          }),
          fields,
        );
      }
      return signInFailed("access_client_refused", new HttpError(503, MISCONFIGURED, { code: "not_configured" }), fields);
    }
    case "bad_answer":
      return signInFailed(
        "access_bad_answer",
        new HttpError(502, "Cloudflare Access gave an answer we can't read. Try connecting to Productive again.", {
          code: "upstream_unavailable",
        }),
        { detail: failure.detail },
      );
  }
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
async function fetchAccessPublicKey(env: Env, kid: unknown) {
  if (!env.ACCESS_JWKS_URL) {
    throw signInFailed("access_jwks_url_missing", new HttpError(503, MISCONFIGURED, { code: "not_configured" }));
  }
  let keys: Array<JsonWebKey & { kid?: string }>;
  try {
    const resp = await fetch(env.ACCESS_JWKS_URL, { signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`Access keys answered ${resp.status}`);
    keys = ((await resp.json()) as { keys: Array<JsonWebKey & { kid?: string }> }).keys;
  } catch (error) {
    throw signInFailed("access_keys_unavailable", new HttpError(503, ACCESS_DOWN, { code: "unavailable" }), { error });
  }
  const jwk = keys.find((key) => key.kid === kid);
  if (!jwk) throw idTokenInvalid(`no Access key with kid ${String(kid)}`);
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["verify"],
  );
}

/**
 * An ID token straight from Access's token endpoint that doesn't verify: that can't happen with
 * the real Access, so it is an `error` worth looking at, not a refusal.
 */
const idTokenInvalid = (detail: string) =>
  signInFailed(
    "id_token_invalid",
    new HttpError(500, "Your sign-in could not be verified. Connect to Productive again.", { code: "internal_error" }),
    { detail },
  );

function parseJWT(token: string) {
  const tokenParts = token.split(".");
  if (tokenParts.length !== 3) throw idTokenInvalid("token must have 3 parts");
  try {
    return {
      data: `${tokenParts[0]}.${tokenParts[1]}`,
      header: JSON.parse(Buffer.from(tokenParts[0], "base64url").toString()),
      payload: JSON.parse(Buffer.from(tokenParts[1], "base64url").toString()),
      signature: tokenParts[2],
    };
  } catch {
    throw idTokenInvalid("token is not JSON");
  }
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
  if (!verified) throw idTokenInvalid("signature does not verify");

  const claims = jwt.payload;
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) throw idTokenInvalid("expired");
  // Every Access app in the team signs with the same keys: only accept tokens issued to ours.
  const audiences: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(env.ACCESS_CLIENT_ID)) throw idTokenInvalid("not issued to this app");
  return claims;
}

/**
 * On every MCP token refresh (tokenExchangeCallback): re-read USER_MAPPING, so removed users lose
 * access and rotated Productive tokens take effect, and refresh the user's Cloudflare Access token,
 * which re-evaluates the Access policy. Throwing invalid_grant revokes the grant; the client then
 * signs in again. Each refresh is one oauth.refresh unit: granted, refused and why, or failed.
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
  // The library answers the OAuthError thrown after the unit. A refusal (the person may no longer
  // sign in) is `skipped` at info and revokes the grant. Our own trouble (Access down or refusing
  // our client, USER_MAPPING unreadable) is never a refusal (functn-it errors/README.md, D6): the
  // unit fails at error, and the client hears temporarily_unavailable, keeps the grant and retries.
  let answer: ProviderOAuthError | undefined;
  const result = await unit("oauth.refresh", { actor: actorOf(current.email) }, async (u) => {
    const signInAgain = (reason: string, description: string) => {
      u.result("skipped");
      u.set({ statusCode: 400, reason });
      answer = new ProviderOAuthError("invalid_grant", { description });
      return undefined;
    };
    const failed = (reason: string, error: unknown, description: string) => {
      u.set({ reason });
      u.fail(error);
      answer = new ProviderOAuthError("temporarily_unavailable", { description, statusCode: 503 });
      return undefined;
    };

    let mapping: UserMapping;
    try {
      mapping = parseUserMapping(env.USER_MAPPING);
    } catch (error) {
      return failed("user_mapping_invalid", error, "The Productive MCP is misconfigured; functn IT has to fix it");
    }
    const productive = lookupProductiveCredentials(current.email, mapping);
    if (!productive) {
      return signInAgain("not_in_user_mapping", `${current.email} is no longer allowed to use this server`);
    }
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
      if (Date.now() >= reauthBy) return signInAgain("reauth_due", "Sign in through Cloudflare Access again");
      u.set({ accessChecked: false });
      return { newProps: { ...next, reauthBy } };
    }

    const accessDown = "Cloudflare Access is unavailable";
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
        signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return failed(timedOut ? "access_timeout" : "access_unreachable", error, accessDown);
    }
    u.set({ accessStatus: response.status });
    const body = (await response.json().catch(() => undefined)) as
      | { refresh_token?: string; error?: unknown }
      | undefined;
    const accessError = typeof body?.error === "string" ? body.error.slice(0, 100) : undefined;
    if (accessError) u.set({ accessError });
    // A 4xx is Access refusing this person's refresh (its policy, a revoked session), except
    // invalid_client, which is our client secret: that would end every session, so it fails.
    if (response.status >= 400 && response.status < 500) {
      if (accessError === "invalid_client") {
        return failed("access_client_refused", new Error(`Access refused our client (${response.status})`), accessDown);
      }
      return signInAgain("access_denied", "Cloudflare Access no longer allows this user");
    }
    if (!response.ok) return failed("access_failing", new Error(`Access answered ${response.status}`), accessDown);
    if (!body) return failed("access_bad_answer", new Error("Access answered a refresh with no JSON"), accessDown);
    u.set({ accessChecked: true, accessRotated: Boolean(body.refresh_token) });
    return {
      newProps: { ...next, accessRefreshToken: body.refresh_token ?? current.accessRefreshToken },
    };
  });
  if (answer) throw answer;
  return result;
}
