import type { ProductiveTransport } from "../api/transport.js";

/** What the Productive client and the tools get for one request: who is asking, and how to reach Productive. */
export interface Config {
  /** e.g. https://api.productive.io/api/v2/ (with the trailing slash). */
  PRODUCTIVE_API_BASE_URL: string;
  /** The signed-in person's Productive person ID ("me"), when their Productive account is connected. */
  PRODUCTIVE_USER_ID?: string;
  /** The signed-in person's Access email. */
  PRODUCTIVE_USER_EMAIL?: string;
  /** Productive as the person (apps.functn.com Connections in the Worker; api/transport.ts). */
  transport: ProductiveTransport;
  /** Productive as the "productive-bot" system user, for what personal tokens can't do (list_users). */
  systemTransport?: ProductiveTransport;
}
