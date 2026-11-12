// Small helpers for answering failures by functn-it's errors convention (errors/README.md).

import type { Actor } from "./lib/log.js";

const EMAIL = /^[^\s@:]+@[^\s@:]+$/;

/** The person as a log line's `actor`: their Access email, or nothing when it isn't one. */
export function actorOf(email: string | undefined): Actor | undefined {
  return email && EMAIL.test(email) ? (email as Actor) : undefined;
}

