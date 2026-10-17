import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { ProductiveTaskList } from '../api/types.js';
import { McpError, ErrorCode } from '../errors.js';

const addToBacklogSchema = z.object({
  task_id: z.string().describe('ID of the task to add to backlog'),
  project_id: z.string().describe('ID of the project containing the task')
});

export async function addToBacklog(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const { task_id, project_id } = addToBacklogSchema.parse(args);
    
    // First, find all folders in the project
    const foldersResponse = await client.listFolders({ project_id });
    
    if (foldersResponse.data.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No folders found in project ${project_id}. Cannot create backlog.`
      );
    }
    
    // Look for a Backlog task list in each folder
    let backlogListId: string | null = null;
    
    for (const folder of foldersResponse.data) {
      const taskListsResponse = await client.listTaskLists({ folder_id: folder.id });
      const backlogList = taskListsResponse.data.find(
        list => list.attributes.name.toLowerCase() === 'backlog'
      );
      
      if (backlogList) {
        backlogListId = backlogList.id;
        break;
      }
    }
    
    // If no backlog list found, create one in the first folder
    if (!backlogListId) {
      const createResponse = await client.createTaskList({
        data: {
          type: 'task_lists',
          attributes: {
            name: 'Backlog',
            description: 'Product backlog for unscheduled tasks',
            project_id: project_id,
            folder_id: foldersResponse.data[0].id
          }
        }
      });
      
      backlogListId = createResponse.data.id;
    }
    
    // Move the task to the backlog
    await client.updateTask(task_id, {
      data: {
        type: 'tasks',
        id: task_id,
        relationships: {
          task_list: {
            data: {
              type: 'task_lists',
              id: backlogListId
            }
          }
        }
      }
    });
    
    return {
      content: [{
        type: 'text',
        text: `✅ Moved task ${task_id} to Backlog (list ID: ${backlogListId})`
      }]
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => e.message).join(', ')}`
      );
    }
    throw error;
  }
}

