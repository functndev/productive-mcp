import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '../errors.js';
import { READ, WRITE, result, runSteps, type RegisterTools, type Step, type TextResult } from './context.js';

export const listTaskListsSchema = z.object({
  folder_id: z.string().optional().describe('Only task lists of this folder'),
  limit: z.number().int().min(1).max(200).optional().default(30).describe('Max task lists (1-200)'),
});

export async function listTaskLists(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listTaskListsSchema.parse(args || {});
    
    const response = await client.listTaskLists({
      folder_id: params.folder_id,
      limit: params.limit,
    });
    
    if (!response || !response.data || response.data.length === 0) {
      const filterText = params.folder_id ? ` for folder ${params.folder_id}` : '';
      return {
        content: [{
          type: 'text',
          text: `No task lists found${filterText}`,
        }],
      };
    }
    
    const taskListsText = response.data.filter(taskList => taskList && taskList.attributes).map(taskList => {
      let text = `Task List: ${taskList.attributes.name} (ID: ${taskList.id})`;
      if (taskList.attributes.description) {
        text += `\nDescription: ${taskList.attributes.description}`;
      }
      if (taskList.attributes.position !== undefined) {
        text += `\nPosition: ${taskList.attributes.position}`;
      }
      if (taskList.relationships?.folder?.data?.id) {
        text += `\nFolder ID: ${taskList.relationships.folder.data.id}`;
      }
      return text;
    }).join('\n\n');
    
    return {
      content: [{
        type: 'text',
        text: taskListsText,
      }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      );
    }
    
    if (error instanceof Error) {
      throw new McpError(
        ErrorCode.InternalError,
        `API error: ${error.message}`
      );
    }
    
    throw new McpError(
      ErrorCode.InternalError,
      'Unknown error occurred while fetching task lists'
    );
  }
}

export const createTaskListSchema = z.object({
  folder_id: z.string().describe('Folder to create the task list in'),
  project_id: z.string().describe('Project of that folder'),
  name: z.string().describe('Task list name'),
  description: z.string().optional().describe('Task list description'),
});

export async function createTaskList(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = createTaskListSchema.parse(args);
    
    const taskListData = {
      data: {
        type: 'task_lists' as const,
        attributes: {
          name: params.name,
          ...(params.description && { description: params.description }),
          position: 0,
          project_id: params.project_id,
          folder_id: params.folder_id,
        },
      },
    };
    
    const response = await client.createTaskList(taskListData);
    
    let text = `Task list created successfully!\n`;
    text += `Name: ${response.data.attributes.name} (ID: ${response.data.id})`;
    if (response.data.attributes.description) {
      text += `\nDescription: ${response.data.attributes.description}`;
    }
    text += `\nFolder ID: ${params.folder_id}`;
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
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      );
    }
    
    if (error instanceof Error) {
      throw new McpError(
        ErrorCode.InternalError,
        `API error: ${error.message}`
      );
    }
    
    throw new McpError(
      ErrorCode.InternalError,
      'Unknown error occurred while creating task list'
    );
  }
}

// --- Get Task List ---

export const getTaskListSchema = z.object({
  task_list_id: z.string().describe('Task list ID'),
});

export async function getTaskList(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = getTaskListSchema.parse(args);

    const response = await client.getTaskList(params.task_list_id);

    const taskList = response.data;
    let text = `Task List: ${taskList.attributes.name} (ID: ${taskList.id})`;
    if (taskList.attributes.description) {
      text += `\nDescription: ${taskList.attributes.description}`;
    }
    if (taskList.attributes.position !== undefined) {
      text += `\nPosition: ${taskList.attributes.position}`;
    }
    if (taskList.relationships?.folder?.data?.id) {
      text += `\nFolder ID: ${taskList.relationships.folder.data.id}`;
    }
    if (taskList.attributes.created_at) {
      text += `\nCreated at: ${taskList.attributes.created_at}`;
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
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      );
    }

    if (error instanceof Error) {
      throw new McpError(
        ErrorCode.InternalError,
        `API error: ${error.message}`
      );
    }

    throw new McpError(
      ErrorCode.InternalError,
      'Unknown error occurred while fetching task list'
    );
  }
}

// --- Update Task List ---

const UpdateTaskListSchema = z.object({
  task_list_id: z.string().describe('The ID of the task list to update'),
  name: z.string().optional().describe('New name for the task list'),
});

export async function updateTaskList(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = UpdateTaskListSchema.parse(args);

    const updateData = {
      data: {
        type: 'task_lists' as const,
        id: params.task_list_id,
        attributes: {
          ...(params.name && { name: params.name }),
        },
      },
    };

    const response = await client.updateTaskList(params.task_list_id, updateData);

    const taskList = response.data;
    let text = `Task list updated successfully!\n`;
    text += `Name: ${taskList.attributes.name} (ID: ${taskList.id})`;
    if (taskList.attributes.description) {
      text += `\nDescription: ${taskList.attributes.description}`;
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
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      );
    }

    if (error instanceof Error) {
      throw new McpError(
        ErrorCode.InternalError,
        `API error: ${error.message}`
      );
    }

    throw new McpError(
      ErrorCode.InternalError,
      'Unknown error occurred while updating task list'
    );
  }
}

// --- Archive Task List ---

const ArchiveTaskListSchema = z.object({
  task_list_id: z.string().describe('The ID of the task list to archive'),
});

export async function archiveTaskList(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = ArchiveTaskListSchema.parse(args);

    await client.archiveTaskList(params.task_list_id);

    return {
      content: [{
        type: 'text',
        text: `Task list ${params.task_list_id} archived successfully.`,
      }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      );
    }

    if (error instanceof Error) {
      throw new McpError(
        ErrorCode.InternalError,
        `API error: ${error.message}`
      );
    }

    throw new McpError(
      ErrorCode.InternalError,
      'Unknown error occurred while archiving task list'
    );
  }
}

// --- Restore Task List ---

const RestoreTaskListSchema = z.object({
  task_list_id: z.string().describe('The ID of the task list to restore'),
});

export async function restoreTaskList(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = RestoreTaskListSchema.parse(args);

    await client.restoreTaskList(params.task_list_id);

    return {
      content: [{
        type: 'text',
        text: `Task list ${params.task_list_id} restored successfully.`,
      }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      );
    }

    if (error instanceof Error) {
      throw new McpError(
        ErrorCode.InternalError,
        `API error: ${error.message}`
      );
    }

    throw new McpError(
      ErrorCode.InternalError,
      'Unknown error occurred while restoring task list'
    );
  }
}

// --- Copy Task List ---

export const copyTaskListSchema = z.object({
  name: z.string().describe('Name of the new task list'),
  template_id: z.string().describe('Task list to copy'),
  project_id: z.string().describe('Project for the new task list'),
  folder_id: z.string().describe('Folder for the new task list'),
  copy_open_tasks: z.boolean().optional().describe("Also copy the template's open tasks"),
  copy_assignees: z.boolean().optional().describe("Also copy the tasks' assignees"),
});

export async function copyTaskList(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = copyTaskListSchema.parse(args);

    const response = await client.copyTaskList({
      name: params.name,
      template_id: params.template_id,
      project_id: params.project_id,
      folder_id: params.folder_id,
      ...(params.copy_open_tasks !== undefined && { copy_open_tasks: params.copy_open_tasks }),
      ...(params.copy_assignees !== undefined && { copy_assignees: params.copy_assignees }),
    });

    const taskList = response.data;
    let text = `Task list copied successfully!\n`;
    text += `Name: ${taskList.attributes.name} (ID: ${taskList.id})`;
    if (taskList.attributes.description) {
      text += `\nDescription: ${taskList.attributes.description}`;
    }
    text += `\nFolder ID: ${params.folder_id}`;

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
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      );
    }

    if (error instanceof Error) {
      throw new McpError(
        ErrorCode.InternalError,
        `API error: ${error.message}`
      );
    }

    throw new McpError(
      ErrorCode.InternalError,
      'Unknown error occurred while copying task list'
    );
  }
}

// --- Move Task List ---

const MoveTaskListSchema = z.object({
  task_list_id: z.string().describe('The ID of the task list to move'),
  folder_id: z.string().describe('The ID of the destination folder'),
});

export async function moveTaskList(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = MoveTaskListSchema.parse(args);

    await client.moveTaskList(params.task_list_id, params.folder_id);

    return {
      content: [{
        type: 'text',
        text: `Task list ${params.task_list_id} moved to folder ${params.folder_id} successfully.`,
      }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      );
    }

    if (error instanceof Error) {
      throw new McpError(
        ErrorCode.InternalError,
        `API error: ${error.message}`
      );
    }

    throw new McpError(
      ErrorCode.InternalError,
      'Unknown error occurred while moving task list'
    );
  }
}

// --- Reposition Task List ---

const RepositionTaskListSchema = z.object({
  task_list_id: z.string().describe('The ID of the task list to reposition'),
  move_before_id: z.string().describe('The ID of the task list to move before'),
});

export async function repositionTaskList(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = RepositionTaskListSchema.parse(args);

    await client.repositionTaskList(params.task_list_id, params.move_before_id);

    return {
      content: [{
        type: 'text',
        text: `Task list ${params.task_list_id} repositioned before ${params.move_before_id} successfully.`,
      }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      );
    }

    if (error instanceof Error) {
      throw new McpError(
        ErrorCode.InternalError,
        `API error: ${error.message}`
      );
    }

    throw new McpError(
      ErrorCode.InternalError,
      'Unknown error occurred while repositioning task list'
    );
  }
}

export const updateTaskListSchema = z.object({
  task_list_id: z.string().describe('Task list to change'),
  name: z.string().min(1).optional().describe('New name'),
  archived: z.boolean().optional().describe('true archives the task list, false restores it'),
  folder_id: z.string().optional().describe('Move the task list to this folder'),
  move_before_id: z.string().optional().describe('Reposition: place before this task list'),
});


/**
 * One tool for every change to an existing task list. Each requested change runs the dedicated
 * implementation (restore, rename, move, reposition, archive), in that order.
 */
async function updateTaskListTool(client: ProductiveAPIClient, args: z.infer<typeof updateTaskListSchema>): Promise<TextResult> {
  const { task_list_id } = args;
  const steps: Step[] = [];

  if (args.archived === false) {
    steps.push(['restore', () => restoreTaskList(client, { task_list_id })]);
  }
  if (args.name !== undefined) {
    steps.push(['name', () => updateTaskList(client, { task_list_id, name: args.name })]);
  }
  if (args.folder_id) {
    steps.push(['move to folder', () => moveTaskList(client, { task_list_id, folder_id: args.folder_id })]);
  }
  if (args.move_before_id) {
    steps.push(['position', () => repositionTaskList(client, { task_list_id, move_before_id: args.move_before_id })]);
  }
  if (args.archived === true) {
    steps.push(['archive', () => archiveTaskList(client, { task_list_id })]);
  }
  return runSteps(steps, 'Nothing to update: pass at least one field besides task_list_id');
}

export const registerTaskListTools: RegisterTools = (server, { client }) => {
  server.registerTool(
    'list_task_lists',
    {
      title: 'List task lists',
      description: 'List task lists, optionally for one folder (find folders with list_folders). Task lists group tasks within a folder.',
      inputSchema: listTaskListsSchema,
      annotations: READ,
    },
    (args) => result(listTaskLists(client, args))
  );
  server.registerTool(
    'get_task_list',
    {
      title: 'Get task list',
      description: 'Get a task list by ID.',
      inputSchema: getTaskListSchema,
      annotations: READ,
    },
    (args) => result(getTaskList(client, args))
  );
  server.registerTool(
    'create_task_list',
    {
      title: 'Create task list',
      description: 'Create a task list in a folder.',
      inputSchema: createTaskListSchema,
      annotations: WRITE,
    },
    (args) => result(createTaskList(client, args))
  );
  server.registerTool(
    'copy_task_list',
    {
      title: 'Copy task list',
      description: 'Create a task list as a copy of another (template) task list, optionally with its open tasks and assignees.',
      inputSchema: copyTaskListSchema,
      annotations: WRITE,
    },
    (args) => result(copyTaskList(client, args))
  );
  server.registerTool(
    'update_task_list',
    {
      title: 'Update task list',
      description: 'Change an existing task list: rename, archive or restore, move to another folder, or reposition. Pass only the fields to change.',
      inputSchema: updateTaskListSchema,
      annotations: WRITE,
    },
    (args) => result(updateTaskListTool(client, args))
  );
};
