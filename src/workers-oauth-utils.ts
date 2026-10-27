// workers-oauth-utils.ts
// OAuth utility functions with CSRF and state validation security fixes

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

/**
 * OAuth 2.1 compliant error class.
 * Represents errors that occur during OAuth operations with standardized error codes and descriptions.
 */
export class OAuthError extends Error {
  /**
   * Creates a new OAuthError
   * @param code - The OAuth error code (e.g., "invalid_request", "invalid_grant")
   * @param description - Human-readable error description
   * @param statusCode - HTTP status code to return (defaults to 400)
   */
  constructor(
    public code: string,
    public description: string,
    public statusCode = 400,
  ) {
    super(description);
    this.name = "OAuthError";
  }

  /**
   * Converts the error to a standardized OAuth error response
   * @returns HTTP Response with JSON error body
   */
  toResponse(): Response {
    return new Response(
      JSON.stringify({
        error: this.code,
        error_description: this.description,
      }),
      {
        status: this.statusCode,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

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
 * @throws {OAuthError} If state is missing, has an invalid signature, or is expired/not found in KV
 */
export async function validateOAuthState(
  request: Request,
  kv: KVNamespace,
  secret: string,
): Promise<ValidateStateResult> {
  const url = new URL(request.url);
  const stateFromQuery = url.searchParams.get("state");

  if (!stateFromQuery) {
    throw new OAuthError("invalid_request", "Missing state parameter", 400);
  }

  // Verify HMAC signature before touching KV — rejects forged/injected state values immediately
  const dotIndex = stateFromQuery.lastIndexOf(".");
  if (dotIndex === -1) {
    throw new OAuthError("invalid_request", "Invalid state format", 400);
  }
  const uuid = stateFromQuery.substring(0, dotIndex);
  const hmac = stateFromQuery.substring(dotIndex + 1);

  const isValid = await verifySignature(hmac, uuid, secret);
  if (!isValid) {
    throw new OAuthError("invalid_request", "Invalid state signature", 400);
  }

  // Look up by UUID only after signature is verified
  const storedDataJson = await kv.get(`oauth:state:${uuid}`);
  if (!storedDataJson) {
    throw new OAuthError("invalid_request", "Invalid or expired state", 400);
  }

  let stored: { oauthReqInfo: AuthRequest; codeVerifier: string };
  try {
    stored = JSON.parse(storedDataJson) as {
      oauthReqInfo: AuthRequest;
      codeVerifier: string;
    };
  } catch (_e) {
    throw new OAuthError("server_error", "Invalid state data", 500);
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

/**
 * Exchanges an authorization code for an access token from the upstream provider.
 * Sends the PKCE code_verifier to bind the exchange to the original authorization request.
 */
export async function fetchUpstreamAuthToken(params: {
  upstream_url: string;
  client_id: string;
  client_secret: string;
  code?: string;
  redirect_uri: string;
  code_verifier: string;
}): Promise<
  | { accessToken: string; idToken: string; refreshToken?: string; error?: undefined }
  | { error: Response }
> {
  if (!params.code) {
    return { error: new Response("Missing authorization code", { status: 400 }) };
  }

  const data = new URLSearchParams({
    client_id: params.client_id,
    client_secret: params.client_secret,
    code: params.code,
    grant_type: "authorization_code",
    redirect_uri: params.redirect_uri,
    code_verifier: params.code_verifier,
  });

  const response = await fetch(params.upstream_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: data.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      error: new Response(`Failed to exchange code for token: ${errorText}`, {
        status: response.status,
      }),
    };
  }

  const body = (await response.json()) as {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
  };
  if (!body.access_token) {
    return { error: new Response("Missing access token", { status: 400 }) };
  }
  if (!body.id_token) {
    return { error: new Response("Missing ID token", { status: 400 }) };
  }
  return { accessToken: body.access_token, idToken: body.id_token, refreshToken: body.refresh_token };
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
