// Errors the tool handlers throw. McpServer turns any error thrown by a tool into an
// isError result carrying its message, so the code only documents the kind of failure.

export enum ErrorCode {
  InvalidRequest = -32600,
  InvalidParams = -32602,
  InternalError = -32603,
}

export class McpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}
