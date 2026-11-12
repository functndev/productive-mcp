import { ProductiveAPIClient } from "./api/client.js";
import { ProductiveApiError } from "./api/fetch.js";
import { connectionsTransport } from "./api/transport.js";
import { errorResponse, HttpError, requestIdOf } from "./lib/http-error.js";
import { type Actor, unit } from "./lib/log.js";
import { base64UrlDecode, base64UrlEncode } from "./oidc.js";

/**
 * Short-lived download links for attachments.
 *
 * get_attachment cannot hand documents to Claude Code as an embedded file:
 * the claude.ai connector strips the blob on the way, and Claude Code then
 * rejects the whole tool result. Instead the tool returns a link to this
 * Worker, which Claude can fetch with curl and open from disk.
 *
 * The link carries the attachment ID, an expiry and the person's own Access
 * for SaaS ID token, encrypted and authenticated with AES-GCM (key from
 * COOKIE_ENCRYPTION_KEY), so nothing in it is readable or can be changed.
 * Whoever holds the link can download that one file until it expires, without
 * logging in. On download the Worker reads the attachment through
 * apps.functn.com Connections as that person, so the link never grants more
 * than they could see in Productive, and stops working once they lose their
 * Productive connection or their ID token expires.
 */

export const ATTACHMENT_PATH_PREFIX = "/attachments/";

/** How long a download link stays valid, at most: never past the ID token in it. */
const LINK_TTL_SECONDS = 15 * 60;

/** Binds a ciphertext to this use of the key: v1 links were HMAC-signed and are no longer accepted. */
const LINK_AAD = new TextEncoder().encode("attachment-download-link-v2");

/** What a link holds, encrypted. */
type LinkPayload = {
  /** Attachment ID. */
  a: string;
  /** The person's Access for SaaS ID token. */
  t: string;
  /** Their email, for the log. */
  e: string;
  /** Expiry, epoch seconds. */
  x: number;
};

/** The AES-GCM key, from COOKIE_ENCRYPTION_KEY with a label of its own, so no extra secret has to be set. */
async function linkKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`attachment-links:${secret}`));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function seal(payload: LinkPayload, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: LINK_AAD },
    await linkKey(secret),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const out = new Uint8Array(iv.length + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), iv.length);
  return base64UrlEncode(out);
}

/** The payload, or null for a link that is malformed, tampered with or sealed with another key. */
async function unseal(value: string, secret: string): Promise<LinkPayload | null> {
  try {
    const bytes = base64UrlDecode(value);
    if (bytes.length < 13) return null;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: LINK_AAD },
      await linkKey(secret),
      bytes.slice(12),
    );
    const payload = JSON.parse(new TextDecoder().decode(plain)) as Partial<LinkPayload>;
    if (typeof payload.a !== "string" || typeof payload.t !== "string" || typeof payload.e !== "string") return null;
    if (typeof payload.x !== "number") return null;
    return payload as LinkPayload;
  } catch {
    return null;
  }
}

export interface AttachmentLinkSigner {
  /** Returns a download URL and when it expires. */
  create(attachmentId: string, filename: string): Promise<{ url: string; expiresAt: Date }>;
}

export function createAttachmentLinkSigner(
  origin: string,
  secret: string,
  person: { email: string; idToken: string; idTokenExpiresAt?: number },
): AttachmentLinkSigner {
  return {
    async create(attachmentId, filename) {
      const now = Math.floor(Date.now() / 1000);
      const tokenExpires = person.idTokenExpiresAt ? Math.floor(person.idTokenExpiresAt / 1000) : Infinity;
      const expires = Math.min(now + LINK_TTL_SECONDS, tokenExpires);
      const sealed = await seal({ a: attachmentId, t: person.idToken, e: person.email, x: expires }, secret);
      // The filename is only there so the URL ends in the real name; it is
      // ignored on download. `'` is escaped too, because get_attachment puts
      // the URL in a single-quoted curl command.
      const path = [attachmentId, filename]
        .map(part => encodeURIComponent(part).replace(/'/g, "%27"))
        .join("/");
      const url = new URL(`${ATTACHMENT_PATH_PREFIX}${path}`, origin);
      url.searchParams.set("l", sealed);
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
  const { kind } = error.options;
  if (kind === "forbidden") {
    // The person's Productive connection is missing or broken, or Productive refused the file.
    return { answer: new HttpError(403, error.message), refusal: true };
  }
  if (kind === "not_configured") {
    return { answer: new HttpError(503, error.message, { code: "not_configured" }), refusal: false };
  }
  if (kind === "upstream" && status !== 0) {
    // apps.functn.com itself failed.
    return { answer: new HttpError(503, error.message, { code: "unavailable" }), refusal: false };
  }
  if (status === 404 || status === 410) {
    return { answer: new HttpError(404, "The attachment no longer exists in Productive."), refusal: true };
  }
  if (status === 403) {
    return { answer: new HttpError(403, "Your Productive account may not open this attachment."), refusal: true };
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
 * Serves `GET /attachments/<id>/<filename>?l=` as one attachment.download unit: a link that is
 * wrong, expired or no longer allowed is `skipped` with its status at info; a failure of ours or
 * Productive's fails the unit at error.
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
  const sealed = url.searchParams.get("l") ?? "";

  return unit("attachment.download", { attachmentId }, async (u) => {
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
      new HttpError(reason === "bad_link" ? 403 : 400, "Invalid download link", {
        code: reason === "bad_link" ? "forbidden" : "invalid_input",
        reason,
      });

    if (!/^\d+$/.test(attachmentId) || !sealed) return refuse(invalid("malformed_link"));
    const link = await unseal(sealed, env.COOKIE_ENCRYPTION_KEY);
    // Tampered with, made for another attachment, or from before v2 (HMAC-signed, `u`/`sig`).
    if (!link || link.a !== attachmentId) return refuse(invalid("bad_link"));
    if (/^[^\s@:]+@[^\s@:]+$/.test(link.e)) u.set({ actor: link.e as Actor });
    if (link.x < Date.now() / 1000) {
      return refuse(
        new HttpError(410, "Download link expired. Call get_attachment again for a new one.", { code: "link_expired" }),
      );
    }

    const client = new ProductiveAPIClient({
      PRODUCTIVE_API_BASE_URL: env.PRODUCTIVE_API_BASE_URL,
      PRODUCTIVE_USER_EMAIL: link.e,
      transport: connectionsTransport(env.CONNECTIONS, { accessToken: link.t }, env.PRODUCTIVE_API_BASE_URL, { requestId }),
    });

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
