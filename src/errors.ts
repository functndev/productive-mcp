// Errors the tool handlers throw. McpServer turns any error thrown by a tool into an
// isError result carrying its message, so the code only documents the kind of failure.

import { getUnit, type Unit } from "./lib/log.js";

export enum ErrorCode {
  InvalidRequest = -32600,
  InvalidParams = -32602,
  InternalError = -32603,
}

// Most tools catch everything and rethrow it as McpError(InternalError, message), so by the time
// a throw reaches the mcp.tool unit its kind is gone. An McpError for bad input or a request the
// tool refuses therefore notes itself on the unit it was created in, and the unit logs the call
// as a tool error the model can fix, not a failure.
const refusals = new WeakMap<Unit, "invalid_params" | "invalid_request">();

/** Whether the current unit created an McpError for bad input or a refused request, and which. */
export function noteOfRefusal(): "invalid_params" | "invalid_request" | undefined {
  const unit = getUnit();
  return unit && refusals.get(unit);
}

export class McpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
    const unit = getUnit();
    if (unit && code === ErrorCode.InvalidParams) refusals.set(unit, "invalid_params");
    else if (unit && code === ErrorCode.InvalidRequest) refusals.set(unit, "invalid_request");
  }
}
