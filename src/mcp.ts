import { fromJsonSchema, McpServer, type CallToolResult, type JsonSchemaType, type JsonSchemaValidatorResult, type jsonSchemaValidator } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type Config } from './config/index.js';
import { ProductiveAPIClient } from './api/client.js';
import { listProjectsTool, listProjectsDefinition } from './tools/projects.js';
import { listTasksTool, getProjectTasksTool, getTaskTool, createTaskTool, updateTaskAssignmentTool, updateTaskDetailsTool, deleteTaskTool, listTasksDefinition, getProjectTasksDefinition, getTaskDefinition, createTaskDefinition, updateTaskAssignmentDefinition, updateTaskDetailsDefinition, deleteTaskDefinition } from './tools/tasks.js';
import { listCompaniesTool, listCompaniesDefinition } from './tools/companies.js';
import { myTasksTool, myTasksDefinition } from './tools/my-tasks.js';
import { listBoards, createBoard, listBoardsTool, createBoardTool } from './tools/boards.js';
import { listTaskLists, createTaskList, listTaskListsTool, createTaskListTool, getTaskList, getTaskListDefinition, updateTaskList, updateTaskListDefinition, archiveTaskList, archiveTaskListDefinition, restoreTaskList, restoreTaskListDefinition, copyTaskList, copyTaskListDefinition, moveTaskList, moveTaskListDefinition, repositionTaskList, repositionTaskListDefinition } from './tools/task-lists.js';
import { whoAmI, whoAmITool } from './tools/whoami.js';
import { listUsers, listUsersTool } from './tools/users.js';
import { listActivities, listActivitiesTool } from './tools/activities.js';
import { getRecentUpdates, getRecentUpdatesTool } from './tools/recent-updates.js';
import { addTaskCommentTool, addTaskCommentDefinition, listCommentsTool, listCommentsDefinition, getCommentTool, getCommentDefinition, updateCommentTool, updateCommentDefinition, deleteCommentTool, deleteCommentDefinition, pinCommentTool, pinCommentDefinition, unpinCommentTool, unpinCommentDefinition, addCommentReactionTool, addCommentReactionDefinition } from './tools/comments.js';
import { updateTaskStatusTool, updateTaskStatusDefinition } from './tools/task-status.js';
import { listWorkflowStatusesTool, listWorkflowStatusesDefinition } from './tools/workflow-statuses.js';
import { listTimeEntresTool, createTimeEntryTool, listServicesTool, getProjectServicesTool, listProjectDealsTool, listDealServicesTool, listTimeEntriesDefinition, createTimeEntryDefinition, listServicesDefinition, getProjectServicesDefinition, listProjectDealsDefinition, listDealServicesDefinition } from './tools/time-entries.js';
import { updateTaskSprint, updateTaskSprintTool } from './tools/task-sprint.js';
import { moveTaskToList, moveTaskToListTool } from './tools/task-list-move.js';
import { addToBacklog, addToBacklogTool } from './tools/task-backlog.js';
import { taskRepositionTool, taskRepositionDefinition, taskRepositionSchema } from './tools/task-reposition.js';
import { generateTimesheetPrompt, timesheetPromptDefinition, generateQuickTimesheetPrompt, quickTimesheetPromptDefinition } from './prompts/timesheet.js';
import { listFolders, listFoldersTool, getFolder, getFolderTool, createFolder, createFolderTool, updateFolder, updateFolderTool, archiveFolder, archiveFolderTool, restoreFolder, restoreFolderTool } from './tools/folders.js';
import { listSubtasksTool, listSubtasksDefinition, createSubtaskTool, createSubtaskDefinition } from './tools/subtasks.js';
import { listTodosTool, listTodosDefinition, getTodoTool, getTodoDefinition, createTodoTool, createTodoDefinition, updateTodoTool, updateTodoDefinition, deleteTodoTool, deleteTodoDefinition } from './tools/todos.js';
import { listPagesTool, listPagesDefinition, getPageTool, getPageDefinition, createPageTool, createPageDefinition, updatePageTool, updatePageDefinition, deletePageTool, deletePageDefinition, movePageTool, movePageDefinition, reorderPagesTool, reorderPagesDefinition, copyPageTool, copyPageDefinition } from './tools/pages.js';
import { listTaskDependenciesTool, listTaskDependenciesDefinition, getTaskDependencyTool, getTaskDependencyDefinition, createTaskDependencyTool, createTaskDependencyDefinition, deleteTaskDependencyTool, deleteTaskDependencyDefinition } from './tools/task-dependencies.js';
import { listBookingsTool, listBookingsDefinition } from './tools/bookings.js';
import { listDealsTool, listDealsDefinition } from './tools/deals.js';
import { listAttachmentsTool, listAttachmentsDefinition, getAttachmentTool, getAttachmentDefinition } from './tools/attachments.js';
import type { AttachmentLinkSigner } from './attachment-links.js';

// Advertised in this order. Commented-out tools are implemented but deliberately not offered.
const TOOL_DEFINITIONS: Array<{ name: string; description: string; inputSchema: unknown }> = [
  whoAmITool,
  listUsersTool,
  listCompaniesDefinition,
  listProjectsDefinition,
  listBoardsTool,
  createBoardTool,
  listTaskListsTool,
  createTaskListTool,
  getTaskListDefinition,
  updateTaskListDefinition,
  archiveTaskListDefinition,
  restoreTaskListDefinition,
  copyTaskListDefinition,
  moveTaskListDefinition,
  repositionTaskListDefinition,
  listTasksDefinition,
  getProjectTasksDefinition,
  getTaskDefinition,
  createTaskDefinition,
  updateTaskAssignmentDefinition,
  updateTaskDetailsDefinition,
  addTaskCommentDefinition,
  updateTaskStatusDefinition,
  listWorkflowStatusesDefinition,
  myTasksDefinition,
  listActivitiesTool,
  getRecentUpdatesTool,
  listTimeEntriesDefinition,
  createTimeEntryDefinition,
  listProjectDealsDefinition,
  listDealServicesDefinition,
  listServicesDefinition,
  getProjectServicesDefinition,
  updateTaskSprintTool,
  moveTaskToListTool,
  addToBacklogTool,
  taskRepositionDefinition,
  // deleteTaskDefinition,
  // Folders
  listFoldersTool,
  getFolderTool,
  createFolderTool,
  updateFolderTool,
  archiveFolderTool,
  restoreFolderTool,
  // Subtasks
  listSubtasksDefinition,
  createSubtaskDefinition,
  // Comments (expanded)
  listCommentsDefinition,
  getCommentDefinition,
  updateCommentDefinition,
  // deleteCommentDefinition,
  pinCommentDefinition,
  unpinCommentDefinition,
  addCommentReactionDefinition,
  // Todos
  listTodosDefinition,
  getTodoDefinition,
  createTodoDefinition,
  updateTodoDefinition,
  // deleteTodoDefinition,
  // Pages
  listPagesDefinition,
  getPageDefinition,
  createPageDefinition,
  updatePageDefinition,
  // deletePageDefinition,
  movePageDefinition,
  reorderPagesDefinition,
  copyPageDefinition,
  // Bookings (resource planning)
  listBookingsDefinition,
  // Deals (sales)
  listDealsDefinition,
  // Attachments
  listAttachmentsDefinition,
  getAttachmentDefinition,
  // Task Dependencies
  listTaskDependenciesDefinition,
  getTaskDependencyDefinition,
  createTaskDependencyDefinition,
  // deleteTaskDependencyDefinition,
];

/** Tools that only read from Productive (shown as read-only to clients, e.g. for permission prompts). */
const isReadOnly = (name: string) => /^(list_|get_)/.test(name) || name === 'my_tasks' || name === 'whoami';

/**
 * Accepts every argument object as-is. The handlers validate their own arguments with zod, and
 * their JSON schemas were never enforced, so enforcing them now could reject calls that work today.
 */
const handlersValidate: jsonSchemaValidator = {
  getValidator<T>() {
    return (data: unknown): JsonSchemaValidatorResult<T> => ({ valid: true, data: data as T, errorMessage: undefined });
  },
};

export function createMcpServer(config: Config, attachmentLinks?: AttachmentLinkSigner): McpServer {
  const server = new McpServer(
    { name: 'productive-mcp', version: '1.0.0' },
    {
      instructions: `Productive.io: Customers → Projects → Boards → Task Lists → Tasks.${config.PRODUCTIVE_USER_ID ? ` The signed-in user ("me") has person ID ${config.PRODUCTIVE_USER_ID}.` : ''}`,
    }
  );
  const apiClient = new ProductiveAPIClient(config);

  // biome-ignore lint/suspicious/noExplicitAny: each handler parses its own arguments
  async function callTool(name: string, args: any): Promise<unknown> {
    switch (name) {
  case 'whoami':
    return await whoAmI(apiClient, args, config);

  case 'list_users':
    return await listUsers(apiClient, args, config.PRODUCTIVE_ADMIN_API_TOKEN);

  case 'list_companies':
    return await listCompaniesTool(apiClient, args);
    
  case 'list_projects':
    return await listProjectsTool(apiClient, args);
    
  case 'list_tasks':
    return await listTasksTool(apiClient, args);
    
  case 'get_project_tasks':
    return await getProjectTasksTool(apiClient, args);
    
  case 'get_task':
    return await getTaskTool(apiClient, args);
    
  case 'my_tasks':
    return await myTasksTool(apiClient, config, args);
    
  case 'list_boards':
    return await listBoards(apiClient, args);
    
  case 'create_board':
    return await createBoard(apiClient, args);
    
  case 'create_task':
    return await createTaskTool(apiClient, args, config);
    
  case 'update_task_assignment':
    return await updateTaskAssignmentTool(apiClient, args, config);
    
  case 'update_task_details':
    return await updateTaskDetailsTool(apiClient, args);
    
  case 'add_task_comment':
    return await addTaskCommentTool(apiClient, args);
    
  case 'update_task_status':
    return await updateTaskStatusTool(apiClient, args);
    
  case 'list_workflow_statuses':
    return await listWorkflowStatusesTool(apiClient, args);
    
  case 'list_task_lists':
    return await listTaskLists(apiClient, args);
    
  case 'create_task_list':
    return await createTaskList(apiClient, args);

  case 'get_task_list':
    return await getTaskList(apiClient, args);

  case 'update_task_list':
    return await updateTaskList(apiClient, args);

  case 'archive_task_list':
    return await archiveTaskList(apiClient, args);

  case 'restore_task_list':
    return await restoreTaskList(apiClient, args);

  case 'copy_task_list':
    return await copyTaskList(apiClient, args);

  case 'move_task_list':
    return await moveTaskList(apiClient, args);

  case 'reposition_task_list':
    return await repositionTaskList(apiClient, args);

  case 'list_activities':
    return await listActivities(apiClient, args);
    
  case 'get_recent_updates':
    return await getRecentUpdates(apiClient, args);
    
  case 'list_time_entries':
    return await listTimeEntresTool(apiClient, args, config);
    
  case 'create_time_entry':
    return await createTimeEntryTool(apiClient, args, config);
    
  case 'list_project_deals':
    return await listProjectDealsTool(apiClient, args);
    
  case 'list_deal_services':
    return await listDealServicesTool(apiClient, args);
    
  case 'list_services':
    return await listServicesTool(apiClient, args);
    
  case 'get_project_services':
    return await getProjectServicesTool(apiClient, args);
    
  case 'update_task_sprint':
    return await updateTaskSprint(apiClient, args);
    
  case 'move_task_to_list':
    return await moveTaskToList(apiClient, args);
    
  case 'add_to_backlog':
    return await addToBacklog(apiClient, args);
    
  case 'reposition_task':
    if (!args?.taskId) {
      throw new Error('taskId is required for task repositioning');
    }
    return await taskRepositionTool(apiClient, args as z.infer<typeof taskRepositionSchema>);

  // case 'delete_task':
  //   return await deleteTaskTool(apiClient, args);

  // Folders
  case 'list_folders':
    return await listFolders(apiClient, args);
  case 'get_folder':
    return await getFolder(apiClient, args);
  case 'create_folder':
    return await createFolder(apiClient, args);
  case 'update_folder':
    return await updateFolder(apiClient, args);
  case 'archive_folder':
    return await archiveFolder(apiClient, args);
  case 'restore_folder':
    return await restoreFolder(apiClient, args);

  // Subtasks
  case 'list_subtasks':
    return await listSubtasksTool(apiClient, args);
  case 'create_subtask':
    return await createSubtaskTool(apiClient, args);

  // Comments (expanded)
  case 'list_comments':
    return await listCommentsTool(apiClient, args);
  case 'get_comment':
    return await getCommentTool(apiClient, args);
  case 'update_comment':
    return await updateCommentTool(apiClient, args);
  // case 'delete_comment':
  //   return await deleteCommentTool(apiClient, args);
  case 'pin_comment':
    return await pinCommentTool(apiClient, args);
  case 'unpin_comment':
    return await unpinCommentTool(apiClient, args);
  case 'add_comment_reaction':
    return await addCommentReactionTool(apiClient, args);

  // Todos
  case 'list_todos':
    return await listTodosTool(apiClient, args);
  case 'get_todo':
    return await getTodoTool(apiClient, args);
  case 'create_todo':
    return await createTodoTool(apiClient, args);
  case 'update_todo':
    return await updateTodoTool(apiClient, args);
  // case 'delete_todo':
  //   return await deleteTodoTool(apiClient, args);

  // Pages
  case 'list_pages':
    return await listPagesTool(apiClient, args);
  case 'get_page':
    return await getPageTool(apiClient, args);
  case 'create_page':
    return await createPageTool(apiClient, args);
  case 'update_page':
    return await updatePageTool(apiClient, args);
  // case 'delete_page':
  //   return await deletePageTool(apiClient, args);
  case 'move_page':
    return await movePageTool(apiClient, args);
  case 'reorder_pages':
    return await reorderPagesTool(apiClient, args);
  case 'copy_page':
    return await copyPageTool(apiClient, args);

  // Bookings
  case 'list_bookings':
    return await listBookingsTool(apiClient, args);

  // Deals
  case 'list_deals':
    return await listDealsTool(apiClient, args);

  // Attachments
  case 'list_attachments':
    return await listAttachmentsTool(apiClient, args);
  case 'get_attachment':
    return await getAttachmentTool(apiClient, attachmentLinks, args);

  // Task Dependencies
  case 'list_task_dependencies':
    return await listTaskDependenciesTool(apiClient, args);
  case 'get_task_dependency':
    return await getTaskDependencyTool(apiClient, args);
  case 'create_task_dependency':
    return await createTaskDependencyTool(apiClient, args);
  // case 'delete_task_dependency':
  //   return await deleteTaskDependencyTool(apiClient, args);

  default:
    throw new Error(`Unknown tool: ${name}`);
}
  }

  for (const definition of TOOL_DEFINITIONS) {
    const { name } = definition;
    server.registerTool(
      name,
      {
        description: definition.description,
        inputSchema: fromJsonSchema(definition.inputSchema as JsonSchemaType, handlersValidate),
        annotations: { readOnlyHint: isReadOnly(name) },
      },
      async (args: unknown) => {
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
            args: args ?? null,
          }));
        try {
          const result = (await callTool(name, args)) as CallToolResult;
          logCall(result.isError ? 'error' : 'ok');
          return result;
        } catch (error) {
          logCall('error', error instanceof Error ? error.message : String(error));
          throw error;
        }
      }
    );
  }

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
