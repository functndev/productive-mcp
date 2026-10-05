import { ProductiveAPIClient } from "./api/client.js";
import { parseConfig } from "./config/index.js";
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

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** `filename*` carries the real name; `filename` is an ASCII fallback. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Serves `GET /attachments/<id>/<filename>?u=&exp=&sig=`. */
export async function handleAttachmentDownload(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return textResponse(405, "Method not allowed");

  const url = new URL(request.url);
  const attachmentId = decodeURIComponent(
    url.pathname.slice(ATTACHMENT_PATH_PREFIX.length).split("/")[0] ?? "",
  );
  const userId = url.searchParams.get("u") ?? "";
  const expires = Number(url.searchParams.get("exp"));
  const signature = fromBase64Url(url.searchParams.get("sig") ?? "");

  if (!/^\d+$/.test(attachmentId) || !userId || !Number.isInteger(expires) || !signature) {
    return textResponse(400, "Invalid download link");
  }

  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(env.COOKIE_ENCRYPTION_KEY),
    signature,
    signedPayload(attachmentId, userId, expires),
  );
  if (!valid) return textResponse(403, "Invalid download link");
  if (expires < Date.now() / 1000) {
    return textResponse(410, "Download link expired. Call get_attachment again for a new one.");
  }

  const entry = Object.values(parseUserMapping(env.USER_MAPPING)).find(
    e => String(e?.userId) === userId,
  );
  if (!entry?.apiToken) return textResponse(403, "Invalid download link");

  const client = new ProductiveAPIClient(
    parseConfig({
      PRODUCTIVE_API_TOKEN: entry.apiToken,
      PRODUCTIVE_USER_ID: userId,
      PRODUCTIVE_ORG_ID: env.PRODUCTIVE_ORG_ID,
      PRODUCTIVE_API_BASE_URL: env.PRODUCTIVE_API_BASE_URL,
    }),
  );

  try {
    const { data: attachment } = await client.getAttachment(attachmentId);
    const a = attachment.attributes;
    if (a.deleted_at) return textResponse(404, "Attachment has been deleted");

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
    return new Response(file.body, { status: 200, headers });
  } catch (error) {
    console.error(`Attachment download ${attachmentId} failed:`, error);
    return textResponse(502, "Could not fetch the attachment from Productive");
  }
}
