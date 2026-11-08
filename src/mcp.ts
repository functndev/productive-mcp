import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type Config } from './config/index.js';
import { ProductiveAPIClient } from './api/client.js';
import type { AttachmentLinkSigner } from './attachment-links.js';
import { productiveStats } from './api/fetch.js';
import { noteOfRefusal } from './errors.js';
import { unit } from './lib/log.js';
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

// A Productive answer with one of these statuses means the model asked for something that doesn't
// exist, isn't allowed or doesn't validate: the model can fix it, so the call is a tool error, not
// a failure. 401 (token rejected), 429 and 5xx fail the call.
const MODEL_FIXABLE_STATUSES = new Set([400, 403, 404, 409, 410, 422]);

/** Why a thrown tool call is the model's to fix, or undefined when it is a failure. */
function toolErrorOf(): string | undefined {
  const stats = productiveStats();
  if (stats?.lastFailedStatus !== undefined) {
    return MODEL_FIXABLE_STATUSES.has(stats.lastFailedStatus) ? `productive_${stats.lastFailedStatus}` : undefined;
  }
  return noteOfRefusal();
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
 * tool, the actor, the ids it was called with, its Productive calls (count, time, failed status)
 * and what it changed (`writes`). A call the model can fix (bad input, a Productive 4xx) is a
 * `toolError`; anything else thrown is a failed unit at error. Tool schemas go out without
 * "$schema".
 */
function logToolCalls(server: McpServer, config: Config): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as { registerTool: unknown }).registerTool = (
    name: string,
    toolConfig: { inputSchema?: StandardSchemaWithJSON },
    callback: (...args: unknown[]) => Promise<{ isError?: boolean }>
  ) =>
    register(name, { ...toolConfig, inputSchema: toolConfig.inputSchema && withoutSchemaUri(toolConfig.inputSchema) }, async (...args: unknown[]) => {
      // McpServer turns a throw into an isError result for the model; it is rethrown after the
      // unit so that stays as it was, and the unit decides how it is logged.
      let thrown: { error: unknown } | undefined;
      const result = await unit(
        'mcp.tool',
        { tool: name, actor: config.PRODUCTIVE_USER_EMAIL, actorPersonId: config.PRODUCTIVE_USER_ID, ...idFields(args[0]) },
        async (u) => {
          try {
            const result = await callback(...args);
            if (result.isError) u.set({ toolError: 'tool' });
            return result;
          } catch (error) {
            thrown = { error };
            const toolError = toolErrorOf();
            if (!toolError) {
              u.fail(error);
              return undefined;
            }
            u.set({ toolError, toolMessage: toolError.startsWith('productive_') ? productiveStats()?.lastFailedMessage : undefined });
            // Some changes were saved before the call failed (a merged update tool).
            if (productiveStats()?.writes.length) u.result('partial');
            return undefined;
          }
        }
      );
      if (thrown) throw thrown.error;
      return result;
    });
}

/**
 * zod puts "$schema": "https://json-schema.org/draft/2020-12/schema" into every tool's JSON
 * Schema; the spec already defaults to 2020-12, so it is ~850 tokens of tools/list for nothing.
 */
function withoutSchemaUri(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const standard = schema['~standard'];
  const strip = ({ $schema: _, ...rest }: Record<string, unknown>) => rest;
  return {
    '~standard': {
      ...standard,
      validate: (value) => standard.validate(value),
      jsonSchema: {
        input: (options) => strip(standard.jsonSchema.input(options)),
        output: (options) => strip(standard.jsonSchema.output(options)),
      },
    },
  };
}
