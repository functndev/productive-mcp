// workers-oauth-utils.ts
// OAuth utility functions with CSRF and state validation security fixes

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { HttpError } from "./lib/http-error.js";

/**
 * How long a call to Cloudflare Access may take (functn-it stack/README.md, "Upstream calls"): a
 * person waits for the sign-in, a client for its token refresh.
 */
export const ACCESS_TIMEOUT_MS = 15_000;

/** What the person reads when the callback can't be tied to a sign-in: they can only start over. */
const START_AGAIN =
  "This sign-in link has expired or was already used. Start connecting to Productive again from Claude.";

/** A callback that doesn't belong to a sign-in in progress: a refusal (400) with its reason. */
const stateRefused = (reason: string) => new HttpError(400, START_AGAIN, { code: "invalid_input", reason });

/**
 * Result from createOAuthState containing the state token and PKCE code challenge
 */
export interface OAuthStateResult {
  /**
   * The generated state token (signed as {uuid}.{hmac}) to be used in OAuth authorization requests
   */
  stateToken: string;
  /**
   * The PKCE code challenge to include in the upstream authorization request
   */
  codeChallenge: string;
}

/**
 * Result from validateOAuthState containing the original OAuth request info and PKCE verifier
 */
export interface ValidateStateResult {
  /**
   * The original OAuth request information that was stored with the state token
   */
  oauthReqInfo: AuthRequest;

  /**
   * The PKCE code verifier to include in the upstream token exchange request
   */
  codeVerifier: string;
}

/**
 * Creates and stores OAuth state information, returning a signed state token and PKCE challenge.
 * The state token is HMAC-signed to prevent state injection attacks: forged values are rejected
 * before any KV operation because the signature check fails first.
 * @param oauthReqInfo - OAuth request information to store with the state
 * @param kv - Cloudflare KV namespace for storing OAuth state data
 * @param secret - Secret key used to HMAC-sign the state token
 * @param stateTTL - Time-to-live for OAuth state in seconds (defaults to 600)
 * @returns Object containing the signed state token and PKCE code challenge
 */
export async function createOAuthState(
  oauthReqInfo: AuthRequest,
  kv: KVNamespace,
  secret: string,
  stateTTL = 600,
): Promise<OAuthStateResult> {
  const uuid = crypto.randomUUID();
  const { codeVerifier, codeChallenge } = await generatePKCE();

  // HMAC-sign the UUID so forged state values are rejected before touching KV
  const hmac = await signData(uuid, secret);
  const stateToken = `${uuid}.${hmac}`;

  // Store oauthReqInfo and codeVerifier together so they can be retrieved at callback
  await kv.put(
    `oauth:state:${uuid}`,
    JSON.stringify({ oauthReqInfo, codeVerifier }),
    {
      expirationTtl: stateTTL,
    },
  );

  return { stateToken, codeChallenge };
}

/**
 * Validates OAuth state from the request, verifying the HMAC signature before any KV lookup,
 * and retrieving the stored OAuth request information and PKCE code verifier.
 * @param request - The HTTP request containing state parameter
 * @param kv - Cloudflare KV namespace for storing OAuth state data
 * @param secret - Secret key used to verify the state token HMAC signature
 * @returns Object containing the original OAuth request info, PKCE code verifier, and cookie to clear
 * @throws {HttpError} 400 with a `reason` if state is missing, has an invalid signature, or is
 *   expired/not found in KV; 500 if the stored state can't be read
 */
export async function validateOAuthState(
  request: Request,
  kv: KVNamespace,
  secret: string,
): Promise<ValidateStateResult> {
  const url = new URL(request.url);
  const stateFromQuery = url.searchParams.get("state");

  if (!stateFromQuery) {
    throw stateRefused("state_missing");
  }

  // Verify HMAC signature before touching KV — rejects forged/injected state values immediately
  const dotIndex = stateFromQuery.lastIndexOf(".");
  if (dotIndex === -1) {
    throw stateRefused("state_malformed");
  }
  const uuid = stateFromQuery.substring(0, dotIndex);
  const hmac = stateFromQuery.substring(dotIndex + 1);

  const isValid = await verifySignature(hmac, uuid, secret);
  if (!isValid) {
    throw stateRefused("state_forged");
  }

  // Look up by UUID only after signature is verified
  const storedDataJson = await kv.get(`oauth:state:${uuid}`);
  if (!storedDataJson) {
    throw stateRefused("state_expired");
  }

  let stored: { oauthReqInfo: AuthRequest; codeVerifier: string };
  try {
    stored = JSON.parse(storedDataJson) as {
      oauthReqInfo: AuthRequest;
      codeVerifier: string;
    };
  } catch (error) {
    // Only this server writes it, so unreadable state is a bug of ours: withOAuthFailures logs it.
    throw new HttpError(500, "Something went wrong on our side. Start connecting to Productive again from Claude.", {
      cause: error,
    });
  }

  // Delete state from KV (one-time use)
  await kv.delete(`oauth:state:${uuid}`);

  return {
    oauthReqInfo: stored.oauthReqInfo,
    codeVerifier: stored.codeVerifier,
  };
}

async function generatePKCE(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = btoa(String.fromCharCode(...verifierBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(codeVerifier),
  );
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return { codeVerifier, codeChallenge };
}

async function signData(data: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const enc = new TextEncoder();
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(data),
  );
  return Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifySignature(
  signatureHex: string,
  data: string,
  secret: string,
): Promise<boolean> {
  if (!signatureHex || !/^[0-9a-f]+$/i.test(signatureHex)) {
    return false;
  }
  const key = await importKey(secret);
  const enc = new TextEncoder();
  try {
    const signatureBytes = new Uint8Array(
      signatureHex.match(/.{1,2}/g)!.map((byte) => Number.parseInt(byte, 16)),
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes.buffer,
      enc.encode(data),
    );
  } catch (_e) {
    return false;
  }
}

async function importKey(secret: string): Promise<CryptoKey> {
  if (!secret) {
    throw new Error("cookieSecret is required for signing cookies");
  }
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Constructs an upstream OAuth authorization URL with query parameters including PKCE
 */
export function getUpstreamAuthorizeUrl(params: {
  upstream_url: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  code_challenge: string;
  code_challenge_method?: string;
}): string {
  const url = new URL(params.upstream_url);
  url.searchParams.set("client_id", params.client_id);
  url.searchParams.set("redirect_uri", params.redirect_uri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.code_challenge);
  url.searchParams.set(
    "code_challenge_method",
    params.code_challenge_method ?? "S256",
  );
  return url.toString();
}

/** Why the code exchange with Cloudflare Access gave no tokens. */
export type AccessTokenFailure =
  /** No answer: unreachable, or nothing within ACCESS_TIMEOUT_MS. */
  | { kind: "unreachable"; timedOut: boolean; error: unknown }
  /** Access refused, with its status and OAuth error code (never its description or body). */
  | { kind: "refused"; accessStatus: number; accessError?: string }
  /** A 2xx without the tokens, or not JSON. */
  | { kind: "bad_answer"; detail: string };

/**
 * Exchanges an authorization code for an access token from the upstream provider.
 * Sends the PKCE code_verifier to bind the exchange to the original authorization request.
 */
export async function fetchUpstreamAuthToken(params: {
  upstream_url: string;
  client_id: string;
  client_secret: string;
  code: string;
  redirect_uri: string;
  code_verifier: string;
}): Promise<
  | { ok: true; accessToken: string; idToken: string; refreshToken?: string }
  | { ok: false; failure: AccessTokenFailure }
> {
  const data = new URLSearchParams({
    client_id: params.client_id,
    client_secret: params.client_secret,
    code: params.code,
    grant_type: "authorization_code",
    redirect_uri: params.redirect_uri,
    code_verifier: params.code_verifier,
  });

  let response: Response;
  try {
    response = await fetch(params.upstream_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: data.toString(),
      signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, failure: { kind: "unreachable", timedOut, error } };
  }

  const body = (await response.json().catch(() => undefined)) as
    | { access_token?: string; id_token?: string; refresh_token?: string; error?: unknown }
    | undefined;
  if (!response.ok) {
    const accessError = typeof body?.error === "string" ? body.error.slice(0, 100) : undefined;
    return { ok: false, failure: { kind: "refused", accessStatus: response.status, ...(accessError && { accessError }) } };
  }
  if (!body) return { ok: false, failure: { kind: "bad_answer", detail: "not JSON" } };
  if (!body.access_token) return { ok: false, failure: { kind: "bad_answer", detail: "no access_token" } };
  if (!body.id_token) return { ok: false, failure: { kind: "bad_answer", detail: "no id_token" } };
  return { ok: true, accessToken: body.access_token, idToken: body.id_token, refreshToken: body.refresh_token };
}

/**
 * Props interface for upstream provider user data
 */
export interface Props {
  accessToken: string;
  email: string;
  login: string;
  name: string;
  productiveUserId: string;
  productiveApiToken: string;
  /** API token of an admin user, used by tools that need elevated access. */
  adminApiToken?: string;
  /** Origin the MCP client connected to, set per request in index.ts. */
  origin?: string;
  /** Cloudflare Access refresh token: used on every MCP token refresh to re-check the Access policy. */
  accessRefreshToken?: string;
  /**
   * When Access issued no refresh token the grant can't be re-checked, so it may only be
   * refreshed until this time (epoch ms); then the user signs in through Access again.
   */
  reauthBy?: number;
  [key: string]: unknown;
}
