import { ProductiveAPIClient } from "./api/client.js";
import { ProductiveApiError } from "./api/fetch.js";
import { errorResponse, HttpError, requestIdOf } from "./lib/http-error.js";
import { unit } from "./lib/log.js";
import { type Config, parseConfig } from "./config/index.js";
import { parseUserMapping } from "./access-handler.js";

/**
 * Short-lived signed download links for attachments.
 *
 * get_attachment cannot hand documents to Claude Code as an embedded file:
 * the claude.ai connector strips the blob on the way, and Claude Code then
 * rejects the whole tool result. Instead the tool returns a link to this
 * Worker, which Claude can fetch with curl and open from disk.
 *
 * The link carries the attachment ID, the Productive user ID and an expiry,
 * signed with HMAC-SHA256. Whoever holds the link can download that one file
 * until it expires, without logging in. On download the Worker re-reads the
 * attachment with that user's own API token, so the link never grants more
 * than the user could see in Productive.
 */

export const ATTACHMENT_PATH_PREFIX = "/attachments/";

/** How long a download link stays valid. */
const LINK_TTL_SECONDS = 15 * 60;

const encoder = new TextEncoder();

/**
 * Derives the signing key from COOKIE_ENCRYPTION_KEY, so no extra secret has
 * to be set. The label keeps these signatures from ever matching a cookie's.
 */
async function signingKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    base,
    encoder.encode("attachment-download-link-v1"),
  );
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function signedPayload(attachmentId: string, userId: string, expires: number): Uint8Array {
  return encoder.encode(`${attachmentId}:${userId}:${expires}`);
}

function toBase64Url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export interface AttachmentLinkSigner {
  /** Returns a signed download URL and when it expires. */
  create(attachmentId: string, filename: string): Promise<{ url: string; expiresAt: Date }>;
}

export function createAttachmentLinkSigner(
  origin: string,
  secret: string,
  userId: string,
): AttachmentLinkSigner {
  return {
    async create(attachmentId, filename) {
      const expires = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
      const signature = await crypto.subtle.sign(
        "HMAC",
        await signingKey(secret),
        signedPayload(attachmentId, userId, expires),
      );
      // The filename is only there so the URL ends in the real name; it is
      // not signed and ignored on download. `'` is escaped too, because
      // get_attachment puts the URL in a single-quoted curl command.
      const path = [attachmentId, filename]
        .map(part => encodeURIComponent(part).replace(/'/g, "%27"))
        .join("/");
      const url = new URL(`${ATTACHMENT_PATH_PREFIX}${path}`, origin);
      url.searchParams.set("u", userId);
      url.searchParams.set("exp", String(expires));
      url.searchParams.set("sig", toBase64Url(signature));
      return { url: url.toString(), expiresAt: new Date(expires * 1000) };
    },
  };
}

/** `filename*` carries the real name; `filename` is an ASCII fallback. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * The answer for a failed Productive call during a download (the caller is curl run by Claude,
 * which only sees the status): the status Productive's means for this link, and whether it is a
 * refusal or a failure of ours or Productive's (functn-it errors/README.md, D6 and D13).
 */
function answerOfProductive(error: ProductiveApiError): { answer: HttpError; refusal: boolean } {
  const { status } = error;
  if (status === 404 || status === 410) {
    return { answer: new HttpError(404, "The attachment no longer exists in Productive."), refusal: true };
  }
  if (status === 403) {
    return { answer: new HttpError(403, "Your Productive account may not open this attachment."), refusal: true };
  }
  if (status === 401) {
    // The user's Productive token in USER_MAPPING was rejected: someone at functn has to replace it.
    return { answer: new HttpError(503, error.message, { code: "not_configured" }), refusal: false };
  }
  if (status === 429) {
    const retryAfter = error.options.retryAfterS === undefined ? {} : { retryAfterS: error.options.retryAfterS };
    return {
      answer: new HttpError(429, error.message, { code: "rate_limited", details: retryAfter }),
      refusal: false,
    };
  }
  if (status === 0 && error.options.timedOut) {
    return { answer: new HttpError(504, error.message, { code: "upstream_timeout" }), refusal: false };
  }
  // Productive's own trouble (5xx), no answer, or a status nothing here expects.
  return {
    answer: new HttpError(502, "Could not fetch the attachment from Productive. Try again shortly.", {
      code: "upstream_unavailable",
    }),
    refusal: false,
  };
}

/** The JSON envelope for curl; a 429 also carries Retry-After. */
function answer(error: HttpError, requestId: string | undefined): Response {
  if (error.requestId === undefined && requestId) error.requestId = requestId;
  const retryAfterS = error.details?.retryAfterS;
  return errorResponse(error, typeof retryAfterS === "number" ? { headers: { "Retry-After": String(retryAfterS) } } : undefined);
}

/**
 * Serves `GET /attachments/<id>/<filename>?u=&exp=&sig=` as one attachment.download unit: a link
 * that is wrong, expired or no longer allowed is `skipped` with its status at info; a failure of
 * ours or Productive's fails the unit at error.
 */
export async function handleAttachmentDownload(request: Request, env: Env): Promise<Response> {
  const requestId = requestIdOf(request);
  if (request.method !== "GET") {
    return answer(new HttpError(405, "Method not allowed", { code: "method_not_allowed" }), requestId);
  }

  const url = new URL(request.url);
  const attachmentId = decodeURIComponent(
    url.pathname.slice(ATTACHMENT_PATH_PREFIX.length).split("/")[0] ?? "",
  );
  const userId = url.searchParams.get("u") ?? "";
  const expires = Number(url.searchParams.get("exp"));
  const signature = fromBase64Url(url.searchParams.get("sig") ?? "");

  const context = { attachmentId, ...(userId && /^\d+$/.test(userId) && { actor: `productive:${userId}` as const }) };
  return unit("attachment.download", context, async (u) => {
    const refuse = (error: HttpError) => {
      u.result("skipped");
      u.set({ statusCode: error.status, reason: error.reason ?? error.code });
      return answer(error, requestId);
    };
    const fail = (error: HttpError, cause: unknown) => {
      u.fail(cause);
      return answer(error, requestId);
    };
    const invalid = (reason: string) =>
      new HttpError(reason === "bad_signature" || reason === "unknown_user" ? 403 : 400, "Invalid download link", {
        code: reason === "bad_signature" || reason === "unknown_user" ? "forbidden" : "invalid_input",
        reason,
      });

    if (!/^\d+$/.test(attachmentId) || !userId || !Number.isInteger(expires) || !signature) {
      return refuse(invalid("malformed_link"));
    }

    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(env.COOKIE_ENCRYPTION_KEY),
      signature,
      signedPayload(attachmentId, userId, expires),
    );
    if (!valid) return refuse(invalid("bad_signature"));
    if (expires < Date.now() / 1000) {
      return refuse(
        new HttpError(410, "Download link expired. Call get_attachment again for a new one.", { code: "link_expired" }),
      );
    }

    let mapping: ReturnType<typeof parseUserMapping>;
    try {
      mapping = parseUserMapping(env.USER_MAPPING);
    } catch (error) {
      return fail(new HttpError(503, "The Productive MCP is misconfigured on our side. Tell functn IT.", { code: "not_configured" }), error);
    }
    const entry = Object.values(mapping).find((e) => String(e?.userId) === userId);
    // Signed for someone who has since been removed from USER_MAPPING.
    if (!entry?.apiToken) return refuse(invalid("unknown_user"));

    let config: Config;
    try {
      config = parseConfig({
        PRODUCTIVE_API_TOKEN: entry.apiToken,
        PRODUCTIVE_USER_ID: userId,
        PRODUCTIVE_ORG_ID: env.PRODUCTIVE_ORG_ID,
        PRODUCTIVE_API_BASE_URL: env.PRODUCTIVE_API_BASE_URL,
      });
    } catch (error) {
      return fail(new HttpError(503, "The Productive MCP is misconfigured on our side. Tell functn IT.", { code: "not_configured" }), error);
    }
    const client = new ProductiveAPIClient(config);

    try {
      const { data: attachment } = await client.getAttachment(attachmentId);
      const a = attachment.attributes;
      if (a.deleted_at) {
        return refuse(new HttpError(404, "The attachment has been deleted in Productive.", { reason: "deleted" }));
      }

      const file = await client.fetchAttachmentFile(a.url);
      const headers = new Headers({
        "Content-Type":
          a.content_type || file.headers.get("content-type") || "application/octet-stream",
        "Content-Disposition": contentDisposition(a.name),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      const length = file.headers.get("content-length");
      if (length) headers.set("Content-Length", length);
      u.set({ sizeBytes: length ? Number(length) : undefined });
      return new Response(file.body, { status: 200, headers });
    } catch (error) {
      if (!(error instanceof ProductiveApiError)) {
        return fail(new HttpError(500, "Something went wrong on our side. Try again.", { code: "internal_error" }), error);
      }
      const { answer: productiveAnswer, refusal } = answerOfProductive(error);
      if (refusal) return refuse(productiveAnswer);
      return fail(productiveAnswer, error);
    }
  });
}
