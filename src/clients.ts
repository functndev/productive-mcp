// Which OAuth clients may receive tokens. Without this, anyone could register a client (or host a
// Client ID Metadata Document) with their own redirect URI and phish a team member through our
// real consent page, with Cloudflare Access signing them in silently.

/** Claude (claude.ai web, Desktop, mobile) — exact callback URLs. */
const ALLOWED_HTTPS_REDIRECTS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);

/** Claude Code and other local MCP clients use a loopback callback on a random port. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return !url.search && ALLOWED_HTTPS_REDIRECTS.has(`${url.origin}${url.pathname}`);
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  return false;
}

/** For dynamic client registration: every requested redirect URI must be allowed. */
export function allowedRegistration(metadata: Record<string, unknown>): boolean {
  const uris = metadata.redirect_uris;
  return Array.isArray(uris) && uris.length > 0 && uris.every((uri) => typeof uri === "string" && isAllowedRedirectUri(uri));
}
