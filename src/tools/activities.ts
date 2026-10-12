import { z } from 'zod';
import { McpError, ErrorCode } from '../errors.js';
import { ProductiveAPIClient } from '../api/client.js';
import { READ, result, type RegisterTools } from './context.js';

export const listActivitiesSchema = z.object({
  task_id: z.string().optional().describe('Only activities on this task'),
  project_id: z.string().optional().describe('Only activities in this project'),
  person_id: z.string().optional().describe('Only activities by this person'),
  item_type: z.string().optional().describe('Item type, e.g. "Task", "Project", "Workspace"'),
  event: z.string().optional().describe('Event type, e.g. "create", "update", "delete"'),
  after: z.string().optional().describe('Only after this ISO 8601 date-time, e.g. "2024-01-01T00:00:00Z"'),
  before: z.string().optional().describe('Only before this ISO 8601 date-time'),
  days_back: z.number().min(1).max(365).optional().describe('Only the last N days (1-365), instead of after'),
  limit: z.number().min(1).max(200).optional().describe('Max activities to return (1-200, default 30)'),
  page: z.number().min(1).optional().describe('Page number, from 1'),
});

export async function listActivities(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listActivitiesSchema.parse(args);
    
    // Helper: Convert days_back to 'after' parameter
    let after = params.after;
    if (params.days_back && !after) {
      const date = new Date();
      date.setDate(date.getDate() - params.days_back);
      after = date.toISOString();
    }
    
    const response = await client.listActivities({
      task_id: params.task_id,
      project_id: params.project_id,
      person_id: params.person_id,
      item_type: params.item_type,
      event: params.event,
      after,
      before: params.before,
      limit: params.limit,
      page: params.page,
    });

    const activities = response.data;
    let output = `Found ${activities.length} activities`;
    
    if (response.meta?.total_count) {
      output += ` (${response.meta.total_count} total)`;
    }
    
    if (params.days_back) {
      output += ` from the last ${params.days_back} days`;
    } else if (after || params.before) {
      output += ` within specified date range`;
    }
    
    output += ':\n\n';

    if (activities.length === 0) {
      output += 'No activities found for the specified criteria.';
    } else {
      for (const activity of activities) {
        const createdAt = new Date(activity.attributes.created_at).toLocaleString();
        const event = activity.attributes.event;
        const itemType = activity.attributes.item_type;
        const itemId = activity.attributes.item_id;
        
        output += `• ${createdAt} - ${event} ${itemType} (ID: ${itemId})`;
        
        if (activity.attributes.changes && Object.keys(activity.attributes.changes).length > 0) {
          const changes = Object.entries(activity.attributes.changes)
            .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
            .join(', ');
          output += `\n  Changes: ${changes}`;
        }
        
        if (activity.relationships?.creator?.data?.id) {
          output += `\n  Creator: Person ID ${activity.relationships.creator.data.id}`;
        }
        
        output += '\n\n';
      }
    }

    if (response.links?.next) {
      output += '\nUse page parameter to get more results.';
    }

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      );
    }
    
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to list activities: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export const registerActivityTools: RegisterTools = (server, { client }) => {
  server.registerTool(
    'list_activities',
    {
      title: 'List activities',
      description: 'List the activity log (creates, updates, deletes), filtered by task, project, person, item type, event and date.',
      inputSchema: listActivitiesSchema,
      annotations: READ,
    },
    (args) => result(listActivities(client, args))
  );
};
