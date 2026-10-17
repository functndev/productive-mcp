import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '../errors.js';
import { ProductiveTaskUpdate, ProductiveIncludedResource, ProductiveAttachment } from '../api/types.js';
import { formatAttachmentList } from './attachments.js';
import type { Config } from '../config/index.js';
import { READ, WRITE, result, resolveMe, runSteps, type RegisterTools, type Step, type TextResult } from './context.js';
import { updateTaskStatusTool } from './task-status.js';
import { updateTaskSprint } from './task-sprint.js';
import { moveTaskToList } from './task-list-move.js';
import { addToBacklog } from './task-backlog.js';
import { taskRepositionTool } from './task-reposition.js';

function resolvePersonName(personId: string | undefined, included?: ProductiveIncludedResource[]): string | undefined {
  if (!personId || !included) return undefined;
  const person = included.find(item => item.type === 'people' && item.id === personId);
  if (!person) return undefined;
  const first = person.attributes.first_name || '';
  const last = person.attributes.last_name || '';
  return `${first} ${last}`.trim() || undefined;
}

function resolveWorkflowStatus(task: { relationships?: Record<string, any> }, included?: ProductiveIncludedResource[]): string | undefined {
  const statusId = task.relationships?.workflow_status?.data?.id;
  if (!statusId || !included) return undefined;
  const status = included.find(item => item.type === 'workflow_statuses' && item.id === statusId);
  return status?.attributes?.name || undefined;
}

export const listTasksSchema = z.object({
  project_id: z.string().optional().describe('Only tasks of this project'),
  assignee_id: z.string().optional().describe('Only tasks assigned to this person ("me" for the current user)'),
  status: z.enum(['open', 'closed']).optional(),
  limit: z.number().int().min(1).max(200).optional().describe('Max tasks (default 200 with project_id, else 30)'),
});

export const getTaskSchema = z.object({
  task_id: z.string().min(1, 'Task ID is required'),
});

export async function listTasksTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listTasksSchema.parse(args || {});
    
    const response = await client.listTasks({
      project_id: params.project_id,
      assignee_id: params.assignee_id && resolveMe(params.assignee_id, client.getConfig()),
      status: params.status,
      limit: params.limit ?? (params.project_id ? 200 : 30),
    });
    
    if (!response || !response.data || response.data.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No tasks found matching the criteria.',
        }],
      };
    }
    
    const tasksText = response.data.filter(task => task && task.attributes).map(task => {
      const projectId = task.relationships?.project?.data?.id;
      const assigneeId = task.relationships?.assignee?.data?.id;
      const assigneeName = resolvePersonName(assigneeId, response.included);
      const workflowStatusName = resolveWorkflowStatus(task, response.included);
      const fallbackStatus = task.attributes.status === 1 ? 'open' : task.attributes.status === 2 ? 'closed' : `status ${task.attributes.status}`;
      const statusText = workflowStatusName || fallbackStatus;
      const assigneeDisplay = assigneeName
        ? `Assignee: ${assigneeName} (ID: ${assigneeId})`
        : assigneeId ? `Assignee ID: ${assigneeId}` : 'Unassigned';
      return `• ${task.attributes.title} (ID: ${task.id})
  Status: ${statusText}
  ${task.attributes.due_date ? `Due: ${task.attributes.due_date}` : 'No due date'}
  ${projectId ? `Project ID: ${projectId}` : ''}
  ${assigneeDisplay}
  ${task.attributes.description ? `Description: ${task.attributes.description}` : ''}`;
    }).join('\n\n');

    const summary = `Found ${response.data.length} task${response.data.length !== 1 ? 's' : ''}${response.meta?.total_count ? ` (showing ${response.data.length} of ${response.meta.total_count})` : ''}:\n\n${tasksText}`;
    
    return {
      content: [{
        type: 'text',
        text: summary,
      }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => e.message).join(', ')}`
      );
    }
    
    throw new McpError(
      ErrorCode.InternalError,
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
}

export async function getTaskTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = getTaskSchema.parse(args);
    
    // Use config from client (injected per-user via Cloudflare Access middleware)
    const config = client.getConfig();
    
    // Create URL with task_list included
    const url = `${config.PRODUCTIVE_API_BASE_URL}tasks/${params.task_id}?include=task_list,assignee,workflow_status,attachments`;
    
    // Create request with proper headers from config
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Auth-Token': config.PRODUCTIVE_API_TOKEN,
        'X-Organization-Id': config.PRODUCTIVE_ORG_ID,
        'Content-Type': 'application/vnd.api+json',
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to get task: ${response.statusText}`);
    }
    
    const data = (await response.json()) as {
      data: { id: string; attributes: any; relationships?: Record<string, any> };
      included?: Array<{ type: string; id: string; attributes: any }>;
    };
    const task = data.data;
    const projectId = task.relationships?.project?.data?.id;
    const assigneeId = task.relationships?.assignee?.data?.id;
    const taskListId = task.relationships?.task_list?.data?.id;
    
    // Resolve workflow status name from included data, fall back to closed boolean
    const workflowStatusName = resolveWorkflowStatus(task, data.included);
    const fallbackStatus = task.attributes.closed === false ? 'open' : task.attributes.closed === true ? 'closed' : 'unknown';
    const statusText = workflowStatusName || fallbackStatus;

    let text = `Task Details:\n\n`;
    text += `Title: ${task.attributes.title}\n`;
    text += `ID: ${task.id}\n`;
    text += `Status: ${statusText}\n`;
    
    if (task.attributes.description) {
      text += `Description: ${task.attributes.description}\n`;
    }
    
    if (task.attributes.due_date) {
      text += `Due Date: ${task.attributes.due_date}\n`;
    } else {
      text += `Due Date: No due date set\n`;
    }
    
    if (projectId) {
      text += `Project ID: ${projectId}\n`;
    }
    
    if (assigneeId) {
      const assigneeName = resolvePersonName(assigneeId, data.included);
      if (assigneeName) {
        text += `Assignee: ${assigneeName} (ID: ${assigneeId})\n`;
      } else {
        text += `Assignee ID: ${assigneeId}\n`;
      }
    } else {
      text += `Assignee: Unassigned\n`;
    }
    
    if (task.attributes.created_at) {
      text += `Created: ${task.attributes.created_at}\n`;
    }
    
    if (task.attributes.updated_at) {
      text += `Updated: ${task.attributes.updated_at}\n`;
    }
    
    // Include any additional attributes that might be useful
    if (task.attributes.priority !== undefined) {
      text += `Priority: ${task.attributes.priority}\n`;
    }
    
    if (task.attributes.placement !== undefined) {
      text += `Position: ${task.attributes.placement}\n`;
    }
    
    // Add useful additional fields from actual API response
    if (task.attributes.task_number) {
      text += `Task Number: ${task.attributes.task_number}\n`;
    }
    
    if (task.attributes.private !== undefined) {
      text += `Private: ${task.attributes.private ? 'Yes' : 'No'}\n`;
    }
    
    if (task.attributes.initial_estimate) {
      text += `Initial Estimate: ${task.attributes.initial_estimate}\n`;
    }
    
    if (task.attributes.worked_time) {
      text += `Worked Time: ${task.attributes.worked_time}\n`;
    }
    
    if (task.attributes.last_activity_at) {
      text += `Last Activity: ${task.attributes.last_activity_at}\n`;
    }
    
    // Include task list ID information if available
    if (taskListId) {
      text += `Task List ID: ${taskListId}\n`;
      
    // If there's included data for the task list, include the name
    if (data.included && Array.isArray(data.included)) {
      const taskList = data.included.find((item: any) => item.type === 'task_lists' && item.id === taskListId);
      if (taskList) {
        text += `Task List: ${taskList.attributes.name}\n`;
      }
    }
    }

    // Surface attachments (including images embedded in the description) so a
    // ticket read reveals its screenshots and their get_attachment IDs.
    const attachments = (data.included ?? []).filter(
      (item: any) => item.type === 'attachments' && !item.attributes?.deleted_at
    ) as ProductiveAttachment[];
    if (attachments.length > 0) {
      text += `\nAttachments (${attachments.length}) - use get_attachment with the attachment ID to read one:\n`;
      text += `${formatAttachmentList(attachments)}\n`;
    }

    return {
      content: [{
        type: 'text',
        text: text,
      }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => e.message).join(', ')}`
      );
    }
    
    throw new McpError(
      ErrorCode.InternalError,
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
}

export const createTaskSchema = z.object({
  title: z.string().min(1, 'Task title is required'),
  description: z.string().optional().describe('Plain text'),
  description_html: z.string().optional().describe('HTML (<h2>, <p>, <ul>, <li>, <strong>, <em>, <a href="">); wins over description'),
  project_id: z.string().optional(),
  task_list_id: z.string().min(1, 'task_list_id is required by the Productive API').describe('Required; find one with list_task_lists'),
  assignee_id: z.string().optional().describe('Person ID, or "me"'),
  due_date: z.string().optional().describe('YYYY-MM-DD'),
  status: z.enum(['open', 'closed']).optional().default('open'),
});

export async function createTaskTool(
  client: ProductiveAPIClient,
  args: unknown,
  config?: { PRODUCTIVE_USER_ID?: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = createTaskSchema.parse(args || {});
    
    // Handle "me" reference for assignee
    let assigneeId = params.assignee_id;
    if (assigneeId === 'me') {
      if (!config?.PRODUCTIVE_USER_ID) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Cannot use "me" reference - PRODUCTIVE_USER_ID is not configured in environment'
        );
      }
      assigneeId = config.PRODUCTIVE_USER_ID;
    }
    
    // Use description_html if provided, otherwise fall back to description
    const descriptionValue = params.description_html || params.description;

    const taskData = {
      data: {
        type: 'tasks' as const,
        attributes: {
          title: params.title,
          description: descriptionValue,
          due_date: params.due_date,
          status: params.status === 'open' ? 1 : 2,
        },
        relationships: {} as any,
      },
    };
    
    // Add relationships if provided
    if (params.project_id) {
      taskData.data.relationships.project = {
        data: {
          id: params.project_id,
          type: 'projects' as const,
        },
      };
    }
    
    if (params.task_list_id) {
      taskData.data.relationships.task_list = {
        data: {
          id: params.task_list_id,
          type: 'task_lists' as const,
        },
      };
    }
    
    if (assigneeId) {
      taskData.data.relationships.assignee = {
        data: {
          id: assigneeId,
          type: 'people' as const,
        },
      };
    }
    
    const response = await client.createTask(taskData);
    
    let text = `Task created successfully!\n`;
    text += `Title: ${response.data.attributes.title} (ID: ${response.data.id})`;
    if (response.data.attributes.description) {
      text += `\nDescription: ${response.data.attributes.description}`;
    }
    const statusText = response.data.attributes.status === 1 ? 'open' : 'closed';
    text += `\nStatus: ${statusText}`;
    if (response.data.attributes.due_date) {
      text += `\nDue date: ${response.data.attributes.due_date}`;
    }
    if (params.project_id) {
      text += `\nProject ID: ${params.project_id}`;
    }
    if (params.task_list_id) {
      text += `\nTask List ID: ${params.task_list_id}`;
    }
    if (assigneeId) {
      text += `\nAssignee ID: ${assigneeId}`;
      if (params.assignee_id === 'me' && config?.PRODUCTIVE_USER_ID) {
        text += ` (me)`;
      }
    }
    if (response.data.attributes.created_at) {
      text += `\nCreated at: ${response.data.attributes.created_at}`;
    }
    
    return {
      content: [{
        type: 'text',
        text: text,
      }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => e.message).join(', ')}`
      );
    }
    if (error instanceof McpError) throw error;
    throw new McpError(
      ErrorCode.InternalError,
      `create_task failed: ${error instanceof Error ? error.message : 'Unknown error occurred'}`
    );
  }
}

const updateTaskAssignmentSchema = z.object({
  task_id: z.string().min(1, 'Task ID is required'),
  assignee_id: z.string().describe('ID of the person to assign (use "null" string to unassign)'),
});

export async function updateTaskAssignmentTool(
  client: ProductiveAPIClient,
  args: unknown,
  config?: { PRODUCTIVE_USER_ID?: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = updateTaskAssignmentSchema.parse(args);
    
    // Handle "me" reference and "null" string
    let assigneeId: string | null = params.assignee_id;
    if (assigneeId === 'me') {
      if (!config?.PRODUCTIVE_USER_ID) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Cannot use "me" reference - PRODUCTIVE_USER_ID is not configured in environment'
        );
      }
      assigneeId = config.PRODUCTIVE_USER_ID;
    } else if (assigneeId === 'null') {
      assigneeId = null;
    }
    
    const taskUpdate: ProductiveTaskUpdate = {
      data: {
        type: 'tasks',
        id: params.task_id,
        relationships: assigneeId ? {
          assignee: {
            data: {
              id: assigneeId,
              type: 'people'
            }
          }
        } : {
          assignee: {
            data: null
          }
        }
      }
    };
    
    const response = await client.updateTask(params.task_id, taskUpdate);
    
    let text = `Task assignment updated successfully!\n`;
    text += `Task: ${response.data.attributes.title} (ID: ${response.data.id})\n`;
    
    if (assigneeId) {
      text += `Assigned to: Person ID ${assigneeId}`;
      if (params.assignee_id === 'me' && config?.PRODUCTIVE_USER_ID) {
        text += ` (me)`;
      }
    } else {
      text += `Task is now unassigned`;
    }
    
    return {
      content: [{
        type: 'text',
        text: text,
      }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => e.message).join(', ')}`
      );
    }
    
    throw new McpError(
      ErrorCode.InternalError,
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
}

const updateTaskDetailsSchema = z.object({
  task_id: z.string().min(1, 'Task ID is required'),
  title: z.string().min(1, 'Task title cannot be empty').optional(),
  description: z.string().optional(),
  description_html: z.string().optional(),
});

export async function updateTaskDetailsTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = updateTaskDetailsSchema.parse(args);
    
    // Ensure at least one field is being updated
    if (!params.title && params.description === undefined && params.description_html === undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'At least one field (title, description, or description_html) must be provided for update'
      );
    }

    const taskUpdate: ProductiveTaskUpdate = {
      data: {
        type: 'tasks',
        id: params.task_id,
        attributes: {}
      }
    };

    // Only include fields that are being updated
    if (params.title) {
      taskUpdate.data.attributes!.title = params.title;
    }

    // Use description_html if provided, otherwise fall back to description
    if (params.description_html !== undefined) {
      taskUpdate.data.attributes!.description = params.description_html;
    } else if (params.description !== undefined) {
      taskUpdate.data.attributes!.description = params.description;
    }
    
    const response = await client.updateTask(params.task_id, taskUpdate);
    
    let text = `Task details updated successfully!\n`;
    text += `Task: ${response.data.attributes.title} (ID: ${response.data.id})\n`;
    
    if (params.title) {
      text += `✓ Title updated to: "${response.data.attributes.title}"\n`;
    }
    
    if (params.description_html !== undefined || params.description !== undefined) {
      if (response.data.attributes.description) {
        const truncated = response.data.attributes.description.length > 100
          ? response.data.attributes.description.substring(0, 100) + '...'
          : response.data.attributes.description;
        text += `✓ Description updated${params.description_html ? ' (HTML)' : ''}: "${truncated}"\n`;
      } else {
        text += `✓ Description cleared\n`;
      }
    }
    
    if (response.data.attributes.updated_at) {
      text += `Updated at: ${response.data.attributes.updated_at}`;
    }
    
    return {
      content: [{
        type: 'text',
        text: text,
      }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => e.message).join(', ')}`
      );
    }
    
    throw new McpError(
      ErrorCode.InternalError,
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
}

const deleteTaskSchema = z.object({
  task_id: z.string().min(1, 'Task ID is required'),
});

export async function deleteTaskTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = deleteTaskSchema.parse(args);

    await client.deleteTask(params.task_id);

    return {
      content: [{
        type: 'text',
        text: `Task ${params.task_id} has been successfully deleted.`,
      }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => e.message).join(', ')}`
      );
    }

    throw new McpError(
      ErrorCode.InternalError,
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
}


export const updateTaskSchema = z.object({
  task_id: z.string().min(1, 'Task ID is required'),
  title: z.string().min(1, 'Task title cannot be empty').optional(),
  description: z.string().optional().describe('Plain text; "" clears it'),
  description_html: z.string().optional().describe('HTML (<h2>, <p>, <ul>, <li>, <strong>, <em>, <a href="">); wins over description'),
  status_name: z.string().optional().describe('Workflow status by name, e.g. "In Progress", "Done" (case-insensitive, partial match; lists the options if ambiguous)'),
  workflow_status_id: z.string().optional().describe('Exact workflow status ID, instead of status_name'),
  assignee_id: z.string().optional().describe('Person ID, "me", or "null" to unassign'),
  sprints: z.union([z.string(), z.array(z.string())]).optional().describe('Sprint(s) like "S03" or ["S03", "S04"]; [] removes all'),
  task_list_id: z.string().optional().describe('Move the task to this task list (same project)'),
  to_backlog: z.boolean().optional().describe("Move the task to its project's Backlog task list (created if missing)"),
  move_before_id: z.string().optional().describe('Reposition: place before this task'),
  move_after_id: z.string().optional().describe('Reposition: place after this task'),
  position: z.enum(['top', 'bottom']).optional().describe('Reposition: top or bottom of its task list'),
});


/**
 * One tool for every change to an existing task. Each requested change runs the dedicated
 * implementation (list move, details, status, assignee, sprints, position), in that order.
 */
async function updateTaskTool(client: ProductiveAPIClient, config: Config, args: z.infer<typeof updateTaskSchema>): Promise<TextResult> {
  const { task_id } = args;
  const steps: Step[] = [];

  if (args.to_backlog && args.task_list_id) {
    throw new McpError(ErrorCode.InvalidParams, 'Pass either task_list_id or to_backlog, not both');
  }
  if (args.to_backlog) {
    steps.push(['move to backlog', async () => {
      const task = await client.getTask(task_id);
      const project_id = task.data.relationships?.project?.data?.id;
      if (!project_id) throw new McpError(ErrorCode.InternalError, `Task ${task_id} has no project`);
      return addToBacklog(client, { task_id, project_id });
    }]);
  }
  if (args.task_list_id) {
    steps.push(['move to task list', () => moveTaskToList(client, { task_id, task_list_id: args.task_list_id })]);
  }
  if (args.title !== undefined || args.description !== undefined || args.description_html !== undefined) {
    steps.push(['details', () => updateTaskDetailsTool(client, { task_id, title: args.title, description: args.description, description_html: args.description_html })]);
  }
  if (args.status_name !== undefined || args.workflow_status_id !== undefined) {
    steps.push(['status', () => updateTaskStatusTool(client, { task_id, status_name: args.status_name, workflow_status_id: args.workflow_status_id })]);
  }
  if (args.assignee_id !== undefined) {
    steps.push(['assignee', () => updateTaskAssignmentTool(client, { task_id, assignee_id: args.assignee_id }, config)]);
  }
  if (args.sprints !== undefined) {
    steps.push(['sprints', () => updateTaskSprint(client, { task_id, sprints: args.sprints })]);
  }
  if (args.move_before_id || args.move_after_id || args.position) {
    steps.push(['position', () => taskRepositionTool(client, {
      taskId: task_id,
      move_before_id: args.move_before_id,
      move_after_id: args.move_after_id,
      moveToTop: args.position === 'top',
      moveToBottom: args.position === 'bottom',
    })]);
  }
  return runSteps(steps, 'Nothing to update: pass at least one field besides task_id');
}

export const registerTaskTools: RegisterTools = (server, { client, config }) => {
  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description: 'List tasks, filtered by project, assignee ("me" for your own tasks) and/or status.',
      inputSchema: listTasksSchema,
      annotations: READ,
    },
    (args) => result(listTasksTool(client, args))
  );
  server.registerTool(
    'get_task',
    {
      title: 'Get task',
      description: 'Get a task with its description, status, assignee, dates, time worked and attachments.',
      inputSchema: getTaskSchema,
      annotations: READ,
    },
    (args) => result(getTaskTool(client, args))
  );
  server.registerTool(
    'create_task',
    {
      title: 'Create task',
      description: 'Create a task in a task list (find one with list_folders → list_task_lists).',
      inputSchema: createTaskSchema,
      annotations: WRITE,
    },
    (args) => result(createTaskTool(client, args, config))
  );
  server.registerTool(
    'update_task',
    {
      title: 'Update task',
      description: 'Change an existing task: title/description, status, assignee, sprints, task list (or backlog) and position. Pass only the fields to change.',
      inputSchema: updateTaskSchema,
      annotations: WRITE,
    },
    (args) => result(updateTaskTool(client, config, args))
  );
};
