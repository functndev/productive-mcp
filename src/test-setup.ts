// bun has no `cloudflare:workers`; the OAuth provider only needs WorkerEntrypoint to exist.
import { mock } from 'bun:test';

mock.module('cloudflare:workers', () => ({
  WorkerEntrypoint: class WorkerEntrypoint {},
}));

// The provider reads compatibility flags from the runtime; mirror wrangler.jsonc.
(globalThis as { Cloudflare?: unknown }).Cloudflare = {
  compatibilityFlags: { global_fetch_strictly_public: true },
};
