import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '../errors.js';
import { READ, result, type RegisterTools } from './context.js';

export const listWorkflowStatusesSchema = z.object({
  workflow_id: z.string().optional().describe('Only statuses of this workflow'),
  category_id: z.number().int().min(1).max(3).optional().describe('1=Not Started, 2=Started, 3=Closed'),
  limit: z.number().int().min(1).max(200).default(50).optional().describe('Max statuses (1-200)'),
});

export async function listWorkflowStatusesTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listWorkflowStatusesSchema.parse(args);
    
    const response = await client.listWorkflowStatuses({
      workflow_id: params.workflow_id,
      category_id: params.category_id,
      limit: params.limit,
    });
    
    if (!response.data || response.data.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No workflow statuses found.',
        }],
      };
    }
    
    const statusesText = response.data.map(status => {
      const categoryName = status.attributes.category_id === 1 ? 'Not Started' :
                          status.attributes.category_id === 2 ? 'Started' :
                          status.attributes.category_id === 3 ? 'Closed' : 
                          `Category ${status.attributes.category_id}`;
      
      return `• ${status.attributes.name} (ID: ${status.id})
  Category: ${categoryName} (${status.attributes.category_id})
  Workflow ID: ${status.relationships?.workflow?.data?.id || 'N/A'}
  Position: ${status.attributes.position || 'N/A'}`;
    }).join('\n\n');
    
    const summary = `Found ${response.data.length} workflow status${response.data.length !== 1 ? 'es' : ''}:\n\n${statusesText}`;
    
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

export const registerWorkflowStatusTools: RegisterTools = (server, { client }) => {
  server.registerTool(
    'list_workflow_statuses',
    {
      title: 'List workflow statuses',
      description: 'List workflow statuses (the values a task status can take), with category: 1=Not Started, 2=Started, 3=Closed.',
      inputSchema: listWorkflowStatusesSchema,
      annotations: READ,
    },
    (args) => result(listWorkflowStatusesTool(client, args))
  );
};
