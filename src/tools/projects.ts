import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '../errors.js';
import { READ, result, type RegisterTools } from './context.js';

export const listProjectsSchema = z.object({
  status: z.enum(['active', 'archived']).optional().describe('Filter by project status'),
  company_id: z.string().optional().describe('Only projects of this company'),
  limit: z.number().int().min(1).max(200).default(30).optional().describe('Max projects (1-200)'),
});

export async function listProjectsTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listProjectsSchema.parse(args || {});
    
    const response = await client.listProjects({
      status: params.status,
      company_id: params.company_id,
      limit: params.limit,
    });
    
    if (!response || !response.data || response.data.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No projects found matching the criteria.',
        }],
      };
    }
    
    const projectsText = response.data.filter(project => project && project.attributes).map(project => {
      const companyId = project.relationships?.company?.data?.id;
      return `• ${project.attributes.name} (ID: ${project.id})
  Status: ${project.attributes.status}
  ${companyId ? `Company ID: ${companyId}` : ''}
  ${project.attributes.description ? `Description: ${project.attributes.description}` : 'No description'}`;
    }).join('\n\n');
    
    const summary = `Found ${response.data.length} project${response.data.length !== 1 ? 's' : ''}${response.meta?.total_count ? ` (showing ${response.data.length} of ${response.meta.total_count})` : ''}:\n\n${projectsText}`;
    
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

export const registerProjectTools: RegisterTools = (server, { client }) => {
  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'List projects, optionally filtered by status or company.',
      inputSchema: listProjectsSchema,
      annotations: READ,
    },
    (args) => result(listProjectsTool(client, args))
  );
};
