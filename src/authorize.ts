// MCP client authorization (Claude → this server), by functn-it's mcp/ convention: straight on to
// Cloudflare Access (Access for SaaS app "Productive MCP", Google only) as the identity step, no page
// of our own. No consent page either: it would only guard against unknown apps receiving tokens, and
// clients.ts already limits that to Claude's callbacks and local clients. The provider's upstream
// helpers (beginUpstream/finishUpstream) bind the flow to the browser; nothing of ours is stored.
// apps.functn.com then decides whether the person may use the server (src/access.ts).

import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  OAuthError,
  type AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import { isMisconfigured, isUnavailable, noIdToken, productiveGrants, refusalMessage, roleFrom } from "./access.js";
import { isAllowedRedirectUri } from "./clients.js";
import { accessClient, type AppEnv, type GrantProps } from "./env.js";
import { errorPage, HttpError, requestIdOf } from "./lib/http-error.js";
import { alreadyLogged, log, type Actor, type LogFields, unit } from "./lib/log.js";
import { redirectFailuresTo } from "./lib/oauth-failures.js";
import {
  buildOidcAuthUrl,
  exchangeOidcCode,
  idTokenExpiry,
  OidcError,
  OidcRefreshDenied,
  OidcUnavailable,
  randomToken,
  refreshOidcToken,
  s256,
} from "./oidc.js";

/** How long a grant may live when Access issued no refresh token to re-check it with. */
const REAUTH_WITHOUT_REFRESH_MS = 24 * 60 * 60 * 1000;

/** The single scope this server grants; what a person may do is decided by their role (apps.functn.com). */
export const MCP_SCOPE = "mcp";

/** Shown when a client outside clients.ts tries to sign in. */
export const NOT_ALLOWED_CLIENT = "This MCP server only signs in Claude and local MCP clients.";

/** What the person and Claude read when the sign-in setup is broken on our side. */
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

/** GET /authorize: check the client, then on to Cloudflare Access. */
export async function handleAuthorize(request: Request, env: AppEnv): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    return authorizeRefused(error);
  }
  // Clients registered before the allowlist are still stored, and a request may leave out
  // redirect_uri (index.ts only checks the query), so the validated one is checked here. Answered
  // with a page, never redirected: the redirect URI itself is what is untrusted.
  if (!isAllowedRedirectUri(authRequest.redirectUri)) {
    log.info("mcp.sign_in_refused", { statusCode: 400, reason: "redirect_uri_not_allowed" });
    return errorPage(new HttpError(400, NOT_ALLOWED_CLIENT));
  }
  // The client and its redirect URI are known from here: a failure goes back to it as
  // error=server_error or temporarily_unavailable (lib/oauth-failures.ts).
  redirectFailuresTo(authRequest.redirectUri, authRequest.state);

  const verifier = randomToken(48);
  const upstream = await env.OAUTH_PROVIDER.beginUpstream(authRequest, { data: { verifier } });
  let url: string;
  try {
    url = await buildOidcAuthUrl(accessClient(env), { state: upstream.state, codeChallenge: await s256(verifier) });
  } catch (error) {
    throw accessFailed(error);
  }
  return redirect(url, upstream.headers);
}

/** GET /oauth/access/callback: Cloudflare Access signed the person in (or didn't). */
export async function handleAccessCallback(request: Request, env: AppEnv): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  let resumed: Awaited<ReturnType<AppEnv["OAUTH_PROVIDER"]["finishUpstream"]>>;
  try {
    resumed = await env.OAUTH_PROVIDER.finishUpstream<{ verifier: string }>(request);
  } catch (error) {
    // No sign-in in progress here (a reload, a link opened twice or in another browser, an expired
    // one): the person can only start over, and no client can be told, so it is a page.
    if (!(error instanceof AuthorizationError)) throw error;
    log.info("mcp.sign_in_refused", { statusCode: 400, reason: "upstream_state_invalid", description: error.description });
    return errorPage(
      new HttpError(400, "This sign-in link has expired or was already used. Start connecting to Productive again from Claude.", {
        code: "invalid_input",
      }),
    );
  }
  const { request: original, headers } = resumed;
  const { verifier } = resumed.data as { verifier: string };
  // The stored request passed the redirect allowlist in handleAuthorize: failures go back to Claude.
  redirectFailuresTo(original.redirectUri, original.state);

  /** A sign-in refused for the person: Claude hears access_denied and ends the connect flow. */
  const refuse = (reason: string, description: string, fields: LogFields = {}) => {
    log.info("mcp.sign_in_refused", { reason, description, redirected: true, ...fields });
    return redirect(authorizationErrorRedirect(original, "access_denied", description), headers);
  };

  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const accessError = params.get("error");
  if (accessError || !code) {
    // The person cancelled at Access, or Access refused them.
    return refuse(
      "access_denied",
      `Cloudflare Access did not sign you in (${(accessError ?? "no code").slice(0, 100)}). Connect to Productive again to retry.`,
    );
  }

  // Access only issues a code to people its policy allows; the ID token (RS256, our issuer and
  // client id, checked in oidc.ts) proves who it was.
  let signIn: Awaited<ReturnType<typeof exchangeOidcCode>>;
  try {
    signIn = await exchangeOidcCode(accessClient(env), code, verifier);
  } catch (error) {
    throw accessFailed(error);
  }
  const { claims, idToken, refreshToken, responseFields } = signIn;
  if (!claims.email) {
    // Access only leaves it out when its app doesn't release the email scope: ours to fix.
    throw signInFailed("no_email_claim", new HttpError(503, MISCONFIGURED, { code: "not_configured" }));
  }
  const email = claims.email.toLowerCase() as Actor;
  // Without it the Access policy can't be re-checked and the grant and ID token can't be renewed on
  // refresh, so the session ends when the ID token does, at the latest after a day.
  if (!refreshToken) log.warn("mcp.no_refresh_token", { actor: email, responseFields });

  // apps.functn.com decides: its grant (roles in app "productive") goes into the MCP grant props.
  const answer = await productiveGrants(env).issue(idToken, email, requestIdOf(request));
  if (!answer.ok) {
    if (isUnavailable(answer) || isMisconfigured(answer)) {
      // Not the person's doing (functn-it errors/ D6): the one `error` line, and the client hears
      // temporarily_unavailable or server_error instead of access_denied.
      const failure = isUnavailable(answer) ? "temporarily_unavailable" : "server_error";
      log.error("mcp.sign_in_failed", {
        actor: email,
        reason: answer.error,
        description: answer.error_description,
      });
      const description = failure === "server_error" ? MISCONFIGURED : answer.error_description;
      return redirect(authorizationErrorRedirect(original, failure, description), headers);
    }
    return refuse(answer.error, `${email}: ${refusalMessage(answer)}`, { actor: email });
  }

  const props: GrantProps = {
    email,
    grant: answer.props.grant,
    idToken,
    idTokenExpiresAt: claims.exp * 1000,
    ...(refreshToken ? { accessRefreshToken: refreshToken } : { reauthBy: Date.now() + REAUTH_WITHOUT_REFRESH_MS }),
  };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: original,
    userId: email,
    metadata: { label: claims.name || email },
    scope: [MCP_SCOPE],
    props,
  });
  log.info("audit.mcp.sign_in", {
    actor: email,
    clientId: original.clientId,
    role: roleFrom(answer.claims.roles),
    accessRefresh: Boolean(refreshToken),
    // The ID token has to outlive the MCP's 10-minute access token (see GrantProps.idToken).
    idTokenTtlS: Math.round(claims.exp - Date.now() / 1000),
  });
  return redirect(redirectTo, headers);
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
    const back = Boolean(error.redirectTo && error.redirectUri && isAllowedRedirectUri(error.redirectUri));
    // statusCode only when the answer is ours to give (a page); a redirect carries the error.
    log.info("mcp.sign_in_refused", {
      ...(!back && { statusCode: 400 }),
      reason: error.code,
      description: error.description,
      redirected: back,
    });
    if (back) return redirect(error.redirectTo!);
    return errorPage(new HttpError(400, `This app's request to connect to Productive is invalid: ${error.description}`));
  }
  if (error instanceof CimdFetchError) {
    log.info("mcp.sign_in_refused", { statusCode: 400, reason: "client_metadata_unavailable", description: error.detail });
    return errorPage(new HttpError(400, "This app could not be verified, so it can't connect to Productive. Try again later."));
  }
  throw error;
}

/**
 * A call to Cloudflare Access during a sign-in that failed, after its `error` line. The person only
 * gets here after Access signed them in (or on the way there), so none of it is theirs to fix:
 * Access unreachable is a 503 (temporarily_unavailable for Claude); a code or ID token Access's own
 * token endpoint gave us that doesn't hold up is a 500 (server_error), retried by connecting again.
 */
function accessFailed(error: unknown): HttpError {
  if (error instanceof OidcUnavailable) {
    return signInFailed("access_unavailable", new HttpError(503, ACCESS_DOWN, { code: "unavailable", cause: error }), { error });
  }
  if (error instanceof OidcError) {
    return signInFailed(
      "access_sign_in_failed",
      new HttpError(500, "Cloudflare Access did not complete the sign-in. Connect to Productive again.", {
        code: "upstream_unavailable",
        cause: error,
      }),
      { error },
    );
  }
  return error as HttpError;
}

/**
 * On every MCP token refresh (tokenExchangeCallback): refresh the person's Cloudflare Access token,
 * which re-evaluates the Access policy, then renew the apps.functn.com grant with the fresh ID token.
 * Someone removed from "Functn Team", revoked in Zero Trust or losing their role here loses access
 * within the 10-minute access token. One mcp.token_refresh unit: granted, refused and why, or failed.
 */
export async function reCheckAccessOnRefresh({
  grantType,
  props,
  env,
}: {
  grantType: string;
  props: unknown;
  env: Env;
}): Promise<{ newProps: GrantProps } | undefined> {
  if (grantType !== "refresh_token") return undefined;
  const current = props as GrantProps;
  // Grants from before the convention kept the email as Access wrote it.
  const email = String(current.email ?? "").toLowerCase() as Actor;
  // Ending a session (invalid_grant) is the re-check doing its job: a refusal on the summary
  // (skipped, with statusCode and reason). Access or apps.functn.com being down, or our
  // configuration, is a failure (functn-it errors/ D6, D13): the summary is its `error` line, the
  // MCP grant stays and the client retries. Both are rethrown for the library to answer.
  let refusal: OAuthError | undefined;
  const result = await unit("mcp.token_refresh", { actor: email }, async (u) => {
    try {
      return await refreshGrant(current, email, env, u.set);
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      refusal = error;
      if (error.statusCode >= 500) {
        u.set({ reason: error.code, description: error.description });
        u.fail(error);
      } else {
        u.set({ statusCode: error.statusCode, reason: error.code, description: error.description });
        u.result("skipped");
      }
      return undefined;
    }
  });
  if (refusal) throw refusal;
  return result;
}

async function refreshGrant(
  current: GrantProps,
  email: Actor,
  env: Env,
  set: (fields: LogFields) => void,
): Promise<{ newProps: GrantProps } | undefined> {
  const signInAgain = (description: string) => new OAuthError("invalid_grant", { description });
  const grants = productiveGrants(env);
  set({ accessRefresh: Boolean(current.accessRefreshToken) });

  if (!current.accessRefreshToken) {
    // No Access refresh token: no fresh ID token to renew the grant with, so it may be refreshed
    // only while that grant still verifies, and never past its re-auth deadline.
    const grant = await grants.verify(current, email);
    if (current.reauthBy && Date.now() < current.reauthBy && grant.ok) return undefined;
    throw signInAgain("Sign in through Cloudflare Access again");
  }

  let refreshed: Awaited<ReturnType<typeof refreshOidcToken>>;
  try {
    refreshed = await refreshOidcToken(accessClient(env), current.accessRefreshToken);
  } catch (error) {
    set({ accessError: error instanceof Error ? error.message : String(error) });
    if (error instanceof OidcRefreshDenied) throw signInAgain("Cloudflare Access no longer allows this user");
    // Access unreachable, failing or refusing our client: keep the grant, let the client retry.
    throw new OAuthError("temporarily_unavailable", { description: "Cloudflare Access is unavailable", statusCode: 503 });
  }

  // Access normally sends a new ID token with every refresh; the old one serves while it is valid.
  const stillValid = current.idToken && (current.idTokenExpiresAt ?? 0) > Date.now();
  const idToken = refreshed.idToken ?? (stillValid ? current.idToken : undefined);
  const idTokenExpiresAt = refreshed.idToken ? idTokenExpiry(refreshed.idToken) : current.idTokenExpiresAt;
  set({ idTokenRenewed: Boolean(refreshed.idToken) });

  // apps.functn.com unreachable: the old grant while it is in its grace period (grant client).
  const answer = idToken ? await grants.refresh(idToken, email, current) : noIdToken();
  if (!answer.ok) {
    if (isUnavailable(answer)) {
      throw new OAuthError("temporarily_unavailable", { description: answer.error_description, statusCode: 503 });
    }
    if (isMisconfigured(answer)) {
      // Our configuration, not the person: keep the grant, fail the refresh (an `error` line).
      set({ grantError: answer.error, grantErrorDescription: answer.error_description });
      throw new OAuthError("server_error", { description: "The Productive MCP is misconfigured; try again later.", statusCode: 500 });
    }
    set({ grantError: answer.error });
    throw signInAgain(refusalMessage(answer));
  }
  set({ role: roleFrom(answer.claims.roles) });
  // Built from scratch: props of grants from before the convention (Productive tokens) are dropped.
  return {
    newProps: {
      email,
      grant: answer.props.grant,
      accessRefreshToken: refreshed.refreshToken ?? current.accessRefreshToken,
      idToken,
      idTokenExpiresAt,
    },
  };
}

function redirect(location: string, headers?: Headers): Response {
  const result = new Headers(headers);
  result.set("Location", location);
  result.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers: result });
}
