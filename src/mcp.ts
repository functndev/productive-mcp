import { McpServer, type StandardSchemaV1, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type Config } from './config/index.js';
import { ProductiveAPIClient } from './api/client.js';
import type { AttachmentLinkSigner } from './attachment-links.js';
import { productiveNotes } from './api/fetch.js';
import { McpError, noteOfRefusal, type ToolErrorKind } from './errors.js';
import { log, unit } from './lib/log.js';
import type { RegisterTools, ToolContext } from './tools/context.js';
import { registerWhoamiTools } from './tools/whoami.js';
import { registerUserTools } from './tools/users.js';
import { registerCompanyTools } from './tools/companies.js';
import { registerProjectTools } from './tools/projects.js';
import { registerTaskListTools } from './tools/task-lists.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerSubtaskTools } from './tools/subtasks.js';
import { registerTodoTools } from './tools/todos.js';
import { registerCommentTools } from './tools/comments.js';
import { registerTaskDependencyTools } from './tools/task-dependencies.js';
import { registerWorkflowStatusTools } from './tools/workflow-statuses.js';
import { registerActivityTools } from './tools/activities.js';
import { registerRecentUpdateTools } from './tools/recent-updates.js';
import { registerTimeTools } from './tools/time-entries.js';
import { registerDealTools } from './tools/deals.js';
import { registerBookingTools } from './tools/bookings.js';
import { registerFolderTools } from './tools/folders.js';
import { registerPageTools } from './tools/pages.js';
import { registerAttachmentTools } from './tools/attachments.js';
import { generateTimesheetPrompt, timesheetPromptDefinition, generateQuickTimesheetPrompt, quickTimesheetPromptDefinition } from './prompts/timesheet.js';

/** Registration order is the tools/list order, which the spec asks to keep deterministic. */
const TOOL_MODULES: RegisterTools[] = [
  registerWhoamiTools,
  registerUserTools,
  registerCompanyTools,
  registerProjectTools,
  registerTaskListTools,
  registerTaskTools,
  registerSubtaskTools,
  registerTodoTools,
  registerCommentTools,
  registerTaskDependencyTools,
  registerWorkflowStatusTools,
  registerActivityTools,
  registerRecentUpdateTools,
  registerTimeTools,
  registerDealTools,
  registerBookingTools,
  registerFolderTools,
  registerPageTools,
  registerAttachmentTools,
];

/** The same for every user, so clients may cache it for an hour (2026-07-28 cache hints). */
const LIST_CACHE = { ttlMs: 60 * 60 * 1000, cacheScope: 'private' as const };

export function createMcpServer(config: Config, attachmentLinks?: AttachmentLinkSigner): McpServer {
  const server = new McpServer(
    { name: 'productive-mcp', title: 'Productive', version: '2.0.0' },
    {
      instructions: `Productive.io: Customers → Projects → Folders → Task Lists → Tasks.${config.PRODUCTIVE_USER_ID ? ` The signed-in user ("me") has person ID ${config.PRODUCTIVE_USER_ID}.` : ''}`,
      cacheHints: { 'tools/list': LIST_CACHE, 'prompts/list': LIST_CACHE },
    }
  );
  logToolCalls(server, config);

  const ctx: ToolContext = { client: new ProductiveAPIClient(config), config, attachmentLinks };
  for (const register of TOOL_MODULES) register(server, ctx);

  for (const prompt of [timesheetPromptDefinition, quickTimesheetPromptDefinition]) {
    server.registerPrompt(
      prompt.name,
      {
        description: prompt.description,
        argsSchema: z.object(
          Object.fromEntries(
            prompt.arguments.map((arg) => {
              const field = z.string().describe(arg.description);
              return [arg.name, arg.required ? field : field.optional()];
            })
          )
        ),
      },
      // biome-ignore lint/suspicious/noExplicitAny: the prompt generators parse their own arguments
      async (args: any) =>
        prompt.name === 'timesheet_entry' ? generateTimesheetPrompt(args) : generateQuickTimesheetPrompt(args)
    );
  }

  return server;
}

/**
 * The kind a Productive status means for the model (logging convention, "MCP tool calls"), or
 * undefined when none fits: 5xx, no answer (0) and anything else fail the call.
 */
function kindOfStatus(status: number): ToolErrorKind | undefined {
  if (status === 400 || status === 422) return 'invalid_input';
  // The Productive token from USER_MAPPING was rejected: someone at functn has to replace it.
  if (status === 401) return 'not_configured';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  return undefined;
}

/**
 * Why a thrown tool call is a tool error, or undefined when it is a failure. A failed Productive
 * call decides it (with Productive's message as `toolMessage`); otherwise an McpError the tool
 * created for bad input or a refused request.
 */
function toolErrorOf(): { toolError: ToolErrorKind; toolMessage?: string } | undefined {
  const notes = productiveNotes();
  if (notes?.lastFailedStatus !== undefined) {
    const toolError = kindOfStatus(notes.lastFailedStatus);
    return toolError && { toolError, toolMessage: notes.lastFailedMessage };
  }
  const toolError = noteOfRefusal();
  return toolError && { toolError };
}

/**
 * What a failed mcp.tool line logs as `error`: an McpError with a cause quotes the tool's output
 * in its message (runSteps lists what it saved), so the line gets the cause instead.
 */
const loggable = (error: unknown) => (error instanceof McpError && error.cause !== undefined ? error.cause : error);

/** An error result the tool built itself, so nothing says what kind it was. */
class UnreportedToolError extends Error {
  override name = 'UnreportedToolError';
}

type ToolResult = { isError?: boolean; content?: Array<{ type: string; text?: string }> };

const textOf = (result: ToolResult) =>
  (result.content ?? []).flatMap((part) => (part.type === 'text' && part.text ? [part.text] : [])).join(' ') || '(no text)';

/** Issues on one mcp.tool line. */
const MAX_ISSUES = 10;

type Issue = StandardSchemaV1.Issue & { code?: unknown; expected?: unknown; received?: unknown };

/**
 * Where the arguments broke the input schema and how, never their values (logging convention,
 * "MCP tool calls"): zod's messages name the expected type or options, not the input.
 */
function issueFields(issues: ReadonlyArray<StandardSchemaV1.Issue>) {
  return issues.slice(0, MAX_ISSUES).map((issue: Issue) => ({
    path: (issue.path ?? []).map((segment) => (typeof segment === 'object' ? segment.key : segment)).join('.'),
    ...(typeof issue.code === 'string' && { code: issue.code }),
    message: issue.message,
    ...(typeof issue.expected === 'string' && { expected: issue.expected }),
    ...(typeof issue.received === 'string' && { received: issue.received }),
  }));
}

/** The ids a tool was called with (`task_id` → `taskId`), never its other arguments (bodies, notes). */
function idFields(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!/(_id|_ids|Id)$/.test(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && !Array.isArray(value)) continue;
    fields[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return fields;
}

/**
 * Wraps registerTool so every call is one mcp.tool unit (logging convention, lib/log.ts): the
 * tool, the actor, the ids it was called with, its Productive calls (productiveCalls, -Ms,
 * -Failed, the last failed productiveStatus) and what it changed (`writes`). A call the model can
 * act on (bad input, a Productive 4xx) is `toolError` with a kind on an `ok` line; a Productive 429
 * is `rate_limited` too, but the person got nothing, so the unit fails. Anything no kind fits is a
 * failed unit at error. Arguments the input schema rejects never reach the tool: withoutSchemaUri's
 * validate writes their mcp.tool line. Tool schemas go out without "$schema".
 */
function logToolCalls(server: McpServer, config: Config): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as { registerTool: unknown }).registerTool = (
    name: string,
    toolConfig: { inputSchema?: StandardSchemaWithJSON },
    callback: (...args: unknown[]) => Promise<ToolResult>
  ) => {
    const context = { tool: name, actor: config.PRODUCTIVE_USER_EMAIL, actorPersonId: config.PRODUCTIVE_USER_ID };
    const inputSchema =
      toolConfig.inputSchema &&
      withoutSchemaUri(toolConfig.inputSchema, (issues, durationMs) =>
        log.info('mcp.tool', {
          ...context,
          result: 'ok',
          toolError: 'invalid_input',
          issues: issueFields(issues),
          ...(issues.length > MAX_ISSUES && { issueCount: issues.length }),
          durationMs,
        })
      );
    return register(name, { ...toolConfig, inputSchema }, async (...args: unknown[]) => {
      // McpServer turns a throw into an isError result for the model; it is rethrown after the
      // unit so that stays as it was, and the unit decides how it is logged.
      let thrown: { error: unknown } | undefined;
      const result = await unit('mcp.tool', { ...context, ...idFields(args[0]) }, async (u) => {
        try {
          const result = await callback(...args);
          // No tool builds its own error result today; one that did would say nothing of its kind.
          if (result.isError) u.fail(new UnreportedToolError(textOf(result)));
          return result;
        } catch (error) {
          thrown = { error };
          const toolError = toolErrorOf();
          if (!toolError) {
            u.fail(loggable(error));
            return undefined;
          }
          // Changes saved before the call failed (a merged update tool) are in `writes`.
          u.set(toolError);
          // A rate limit the call didn't ride out leaves the person with nothing.
          if (toolError.toolError === 'rate_limited') u.fail(loggable(error));
          return undefined;
        }
      });
      if (thrown) throw thrown.error;
      return result;
    });
  };
}

/**
 * zod puts "$schema": "https://json-schema.org/draft/2020-12/schema" into every tool's JSON
 * Schema; the spec already defaults to 2020-12, so it is ~850 tokens of tools/list for nothing.
 * `rejected` hears of arguments the schema turns down: the SDK then answers the model itself.
 */
function withoutSchemaUri(
  schema: StandardSchemaWithJSON,
  rejected: (issues: ReadonlyArray<StandardSchemaV1.Issue>, durationMs: number) => void
): StandardSchemaWithJSON {
  const standard = schema['~standard'];
  const strip = ({ $schema: _, ...rest }: Record<string, unknown>) => rest;
  return {
    '~standard': {
      ...standard,
      validate: async (value) => {
        const started = Date.now();
        const result = await standard.validate(value);
        if (result.issues?.length) rejected(result.issues, Date.now() - started);
        return result;
      },
      jsonSchema: {
        input: (options) => strip(standard.jsonSchema.input(options)),
        output: (options) => strip(standard.jsonSchema.output(options)),
      },
    },
  };
}
