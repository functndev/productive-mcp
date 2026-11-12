// How a request reaches Productive. In the Worker: through apps.functn.com Connections, which adds the
// signed-in person's own Productive token (or, for list_users, the "productive-bot" system
// credential) and the organization. No Productive token ever passes through this Worker
// (functn-it mcp/ "Upstream credentials", 1).

import {
  connections,
  type CallContext,
  type ProviderError,
  type ProviderRequest,
  type UserAuth,
} from "../apps-functn-com/connections-client.js";
import { ProductiveApiError } from "./fetch.js";

/** fetch() for Productive URLs (the API base or the files host); no credentials in `init`. */
export type ProductiveTransport = (url: string, init?: RequestInit) => Promise<Response>;

/** Where people connect their Productive account when none is connected or it stopped working. */
const APPS_URL = "https://apps.functn.com";

/** Headers Connections sets itself (and drops from callers); never sent from here. */
const CREDENTIAL_HEADERS = new Set(["x-auth-token", "x-organization-id", "authorization"]);

function headersOf(init: RequestInit | undefined): Record<string, string> | undefined {
  if (!init?.headers) return undefined;
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    if (!CREDENTIAL_HEADERS.has(name)) headers[name] = value;
  });
  return headers;
}

/**
 * Productive through Connections, as the person (`auth` is their Access for SaaS ID token) or with
 * a system credential. URLs under `baseUrl` go as paths relative to it; others (attachment files on
 * files.productive.io) as they are, and Connections authenticates them itself.
 */
export function connectionsTransport(
  binding: unknown,
  auth: UserAuth,
  baseUrl: string,
  options: CallContext & { systemCredential?: "productive-bot" } = {},
): ProductiveTransport {
  const api = connections(binding);
  const context: CallContext = options.requestId ? { requestId: options.requestId } : {};
  return async (url, init) => {
    const req: ProviderRequest = {
      method: (init?.method ?? "GET").toUpperCase() as ProviderRequest["method"],
      path: url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url,
      headers: headersOf(init),
      body: (init?.body as ProviderRequest["body"]) ?? null,
    };
    let result;
    try {
      const call = options.systemCredential
        ? api.requestAsSystem(auth, options.systemCredential, req, context)
        : api.request(auth, "productive", req, context);
      result = await (init?.signal ? untilAborted(call, init.signal) : call);
    } catch (error) {
      // productiveFetch's timeout: it words that itself.
      if (init?.signal?.aborted) throw error;
      // The binding's error text is not for the model.
      throw new ProductiveApiError("apps.functn.com is not working right now. Try again in a minute.", 503, {
        kind: "upstream",
        cause: error,
      });
    }
    if (result.ok) return result.response;
    throw refusalOf(result);
  };
}

/** `pending`, or the signal's reason once it aborts: an RPC call can't be aborted itself. */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * What a Connections refusal means for the model and the log (functn-it errors/ D6): the person's
 * missing or broken Productive connection is theirs to fix (`forbidden`, with where to fix it);
 * apps.functn.com refusing our own call is our configuration (`not_configured`, an `error`);
 * apps.functn.com or Productive down is `upstream`.
 */
export function refusalOf(error: ProviderError): ProductiveApiError {
  switch (error.error) {
    case "not_connected":
    case "token_invalid":
      return new ProductiveApiError(
        `${error.message} Connect your Productive account at ${error.connectUrl || APPS_URL}, then try again.`,
        403,
        { kind: "forbidden", connectionsError: error.error },
      );
    case "forbidden_by_provider":
      return new ProductiveApiError(error.message, 403, { kind: "forbidden", connectionsError: error.error });
    case "provider_unavailable":
      return new ProductiveApiError("Could not reach Productive. Try again shortly.", 0, {
        kind: "upstream",
        connectionsError: error.error,
      });
    case "unavailable":
      return new ProductiveApiError(error.message, 503, { kind: "upstream", connectionsError: error.error });
    case "unauthenticated":
    case "not_allowed":
      return new ProductiveApiError(
        "apps.functn.com did not accept this server's call to Productive. Tell functn IT; trying again will not help.",
        500,
        { kind: "not_configured", connectionsError: error.error, cause: new Error(error.message) },
      );
  }
}
