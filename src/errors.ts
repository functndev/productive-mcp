// Errors the tool handlers throw. McpServer turns any error thrown by a tool into an
// isError result carrying its message, so the code only documents the kind of failure.

import { getUnit, type ToolError, type Unit } from "./lib/log.js";

export enum ErrorCode {
  InvalidRequest = -32600,
  InvalidParams = -32602,
  InternalError = -32603,
}

/** A `toolError` kind (logging convention, "MCP tool calls"). */
export type ToolErrorKind = ToolError;

// Most tools catch everything and rethrow it as McpError(InternalError, message), so by the time
// a throw reaches the mcp.tool unit its kind is gone. An McpError for bad input or a request the
// tool refuses therefore notes its kind on the unit it was created in, and the unit logs the call
// as a tool error, not a failure.
const refusals = new WeakMap<Unit, ToolErrorKind>();

/** The kind of the McpError for bad input or a refused request the current unit created, if any. */
export function noteOfRefusal(): ToolErrorKind | undefined {
  const unit = getUnit();
  return unit && refusals.get(unit);
}

export class McpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /**
     * The kind the mcp.tool line logs, for InvalidParams and InvalidRequest; `invalid_input`
     * unless given (`not_configured` for a credential or mapping someone at functn must set up).
     */
    kind?: ToolErrorKind,
  ) {
    super(message);
    this.name = "McpError";
    const unit = getUnit();
    if (unit && (code === ErrorCode.InvalidParams || code === ErrorCode.InvalidRequest)) {
      refusals.set(unit, kind ?? "invalid_input");
    }
  }
}
