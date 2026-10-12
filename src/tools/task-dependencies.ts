import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '../errors.js';
import { ProductiveIncludedResource } from '../api/types.js';
import { READ, WRITE, result, type RegisterTools } from './context.js';

function resolveTaskTitle(taskId: string | undefined, included?: ProductiveIncludedResource[]): string | undefined {
  if (!taskId || !included) return undefined;
  const task = included.find(item => item.type === 'tasks' && item.id === taskId);
  return task?.attributes?.title as string | undefined;
}

function dependencyTypeLabel(typeId: number): string {
  switch (typeId) {
    case 1: return 'blocks (finish to start)';
    case 2: return 'is blocked by';
    case 3: return 'related to';
    default: return `type ${typeId}`;
  }
}

// ---- Schemas ----

export const listTaskDependenciesSchema = z.object({
  task_id: z.string().optional().describe('Source task (the blocker): shows what this task blocks'),
  dependent_task_id: z.string().optional().describe('Dependent task (the blocked one): shows what blocks this task'),
  limit: z.number().int().min(1).max(200).default(50).optional().describe('Max results (1-200, default 50)'),
});

export const getTaskDependencySchema = z.object({
  dependency_id: z.string().min(1, 'Dependency ID is required'),
});

export const createTaskDependencySchema = z.object({
  task_id: z.string().min(1, 'Task ID is required (the blocker)').describe('Source task (the blocker)'),
  dependent_task_id: z.string().min(1, 'Dependent task ID is required (the blocked task)').describe('Dependent task (the blocked one)'),
  type_id: z.number().int().min(1).max(3).default(1).describe('1 = blocks (finish to start, default), 2 = is blocked by, 3 = related to'),
});

const deleteTaskDependencySchema = z.object({
  dependency_id: z.string().min(1, 'Dependency ID is required'),
});

// ---- Handlers ----

export async function listTaskDependenciesTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listTaskDependenciesSchema.parse(args || {});

    const response = await client.listTaskDependencies({
      task_id: params.task_id,
      dependent_task_id: params.dependent_task_id,
      limit: params.limit,
    });

    if (!response.data || response.data.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No task dependencies found.',
        }],
      };
    }

    const depsText = response.data.map(dep => {
      const taskId = dep.relationships?.task?.data?.id;
      const depTaskId = dep.relationships?.dependent_task?.data?.id;
      const taskTitle = resolveTaskTitle(taskId, response.included);
      const depTaskTitle = resolveTaskTitle(depTaskId, response.included);
      const typeLabel = dependencyTypeLabel(dep.attributes.type_id);

      const taskDisplay = taskTitle ? `${taskTitle} (ID: ${taskId})` : `Task ${taskId}`;
      const depDisplay = depTaskTitle ? `${depTaskTitle} (ID: ${depTaskId})` : `Task ${depTaskId}`;

      return `- Dependency ID: ${dep.id}\n  ${taskDisplay} → ${typeLabel} → ${depDisplay}\n  Type ID: ${dep.attributes.type_id}`;
    }).join('\n\n');

    return {
      content: [{
        type: 'text',
        text: `Found ${response.data.length} dependency(ies):\n\n${depsText}`,
      }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => e.message).join(', ')}`);
    }
    throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : 'Unknown error occurred');
  }
}

export async function getTaskDependencyTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = getTaskDependencySchema.parse(args);
    const response = await client.getTaskDependency(params.dependency_id);
    const dep = response.data;

    const taskId = dep.relationships?.task?.data?.id;
    const depTaskId = dep.relationships?.dependent_task?.data?.id;
    const taskTitle = resolveTaskTitle(taskId, response.included);
    const depTaskTitle = resolveTaskTitle(depTaskId, response.included);
    const typeLabel = dependencyTypeLabel(dep.attributes.type_id);

    let text = `Dependency ID: ${dep.id}\n`;
    text += `Type: ${typeLabel} (type_id: ${dep.attributes.type_id})\n`;
    text += `Task: ${taskTitle || 'Unknown'} (ID: ${taskId})\n`;
    text += `Dependent task: ${depTaskTitle || 'Unknown'} (ID: ${depTaskId})\n`;
    if (dep.attributes.created_at) text += `Created at: ${dep.attributes.created_at}`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => e.message).join(', ')}`);
    }
    throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : 'Unknown error occurred');
  }
}

export async function createTaskDependencyTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = createTaskDependencySchema.parse(args);

    const response = await client.createTaskDependency({
      data: {
        type: 'task_dependencies',
        attributes: {
          task_id: params.task_id,
          dependent_task_id: params.dependent_task_id,
          type_id: params.type_id.toString(),
        },
      },
    });

    const dep = response.data;
    const typeLabel = dependencyTypeLabel(dep.attributes.type_id);

    let text = `Task dependency created successfully!\n`;
    text += `Dependency ID: ${dep.id}\n`;
    text += `Type: ${typeLabel}\n`;
    text += `Task ${params.task_id} → ${typeLabel} → Task ${params.dependent_task_id}`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => e.message).join(', ')}`);
    }
    throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : 'Unknown error occurred');
  }
}

export async function deleteTaskDependencyTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = deleteTaskDependencySchema.parse(args);
    await client.deleteTaskDependency(params.dependency_id);

    return {
      content: [{
        type: 'text',
        text: `Task dependency ${params.dependency_id} deleted successfully.`,
      }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => e.message).join(', ')}`);
    }
    throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : 'Unknown error occurred');
  }
}

export const registerTaskDependencyTools: RegisterTools = (server, { client }) => {
  server.registerTool(
    'list_task_dependencies',
    {
      title: 'List task dependencies',
      description: 'List blocker/related links between tasks: filter by task_id for what a task blocks, or dependent_task_id for what blocks it.',
      inputSchema: listTaskDependenciesSchema,
      annotations: READ,
    },
    (args) => result(listTaskDependenciesTool(client, args))
  );
  server.registerTool(
    'get_task_dependency',
    {
      title: 'Get task dependency',
      description: 'Get one task dependency with both tasks and its type.',
      inputSchema: getTaskDependencySchema,
      annotations: READ,
    },
    (args) => result(getTaskDependencyTool(client, args))
  );
  server.registerTool(
    'create_task_dependency',
    {
      title: 'Create task dependency',
      description: 'Link two tasks: task_id blocks dependent_task_id (type 1), is blocked by it (2), or is related to it (3).',
      inputSchema: createTaskDependencySchema,
      annotations: WRITE,
    },
    (args) => result(createTaskDependencyTool(client, args))
  );
};
