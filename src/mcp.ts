import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type Config } from './config/index.js';
import { ProductiveAPIClient } from './api/client.js';
import type { AttachmentLinkSigner } from './attachment-links.js';
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
 * Wraps registerTool so every call logs one tool_call line (same shape as functn-tracking-mcp),
 * which is what Grafana counts tool usage from, and so tool schemas go out without "$schema".
 */
function logToolCalls(server: McpServer, config: Config): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as { registerTool: unknown }).registerTool = (
    name: string,
    toolConfig: { inputSchema?: StandardSchemaWithJSON },
    callback: (...args: unknown[]) => Promise<{ isError?: boolean }>
  ) =>
    register(name, { ...toolConfig, inputSchema: toolConfig.inputSchema && withoutSchemaUri(toolConfig.inputSchema) }, async (...args: unknown[]) => {
      const startedAt = Date.now();
      const logCall = (outcome: 'ok' | 'error', error?: string) =>
        // console.log, not console.error: the logging tail worker drops error-level lines of
        // invocations whose client disconnected.
        console.log(JSON.stringify({
          event: 'tool_call',
          tool: name,
          userId: config.PRODUCTIVE_USER_ID,
          userEmail: config.PRODUCTIVE_USER_EMAIL,
          durationMs: Date.now() - startedAt,
          outcome,
          ...(error !== undefined && { error }),
          args: args[0] ?? null,
        }));
      try {
        const result = await callback(...args);
        logCall(result.isError ? 'error' : 'ok');
        return result;
      } catch (error) {
        logCall('error', error instanceof Error ? error.message : String(error));
        throw error;
      }
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
