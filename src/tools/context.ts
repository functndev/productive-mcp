// What every tool module gets, and how it registers its tools.

import type { CallToolResult, McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import type { ProductiveAPIClient } from '../api/client.js';
import type { AttachmentLinkSigner } from '../attachment-links.js';
import type { Config } from '../config/index.js';
import { ErrorCode, McpError } from '../errors.js';

export interface ToolContext {
  client: ProductiveAPIClient;
  config: Config;
  /** Makes download links for attachments; absent when the sign-in holds no ID token to put in them. */
  attachmentLinks?: AttachmentLinkSigner;
}

/** Each tool module exports one of these; mcp.ts calls them in a fixed order (= tools/list order). */
export type RegisterTools = (server: McpServer, ctx: ToolContext) => void;

/** Only reads from Productive. */
export const READ: ToolAnnotations = { readOnlyHint: true };
/** Creates or changes records; nothing is deleted. */
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };

/** The handlers return plain text content; this gives them the SDK's result type. */
export const result = async (pending: Promise<unknown>): Promise<CallToolResult> => (await pending) as CallToolResult;

/** Why "me" can't be resolved: the person's Productive account isn't connected on apps.functn.com. */
export const ME_UNAVAILABLE =
  '"me" is not available: no Productive account is connected to your sign-in. Connect it at https://apps.functn.com, then try again.';

/** Resolves "me" to the signed-in user's person ID; other values pass through. */
export function resolveMe(id: string, config: Config): string {
  if (id !== 'me') return id;
  if (!config.PRODUCTIVE_USER_ID) throw new McpError(ErrorCode.InvalidRequest, ME_UNAVAILABLE, 'forbidden');
  return config.PRODUCTIVE_USER_ID;
}

export type TextResult = { content: Array<{ type: string; text: string }> };
export type Step = [label: string, run: () => Promise<TextResult>];

/**
 * Runs the changes a merged update tool was asked for, in order, and joins their reports. If a
 * step fails after others succeeded, the error lists what was already saved, so the model
 * doesn't redo it.
 */
export async function runSteps(steps: Step[], nothingToDo: string): Promise<TextResult> {
  if (steps.length === 0) throw new McpError(ErrorCode.InvalidParams, nothingToDo);
  const done: string[] = [];
  for (const [label, step] of steps) {
    try {
      const { content } = await step();
      done.push(content.map((c) => c.text).join('\n'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The message quotes what was saved (titles, text), so the mcp.tool line logs the cause.
      throw Object.assign(
        new McpError(ErrorCode.InternalError, done.length ? `${done.join('\n\n')}\n\nThen the ${label} change failed: ${message}` : message),
        { cause: error },
      );
    }
  }
  return { content: [{ type: 'text', text: done.join('\n\n') }] };
}
