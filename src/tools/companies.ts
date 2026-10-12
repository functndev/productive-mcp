import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '../errors.js';
import { READ, result, type RegisterTools } from './context.js';

export const listCompaniesSchema = z.object({
  status: z.enum(['active', 'archived']).optional().describe('Filter by company status'),
  limit: z.number().int().min(1).max(200).default(30).optional().describe('Max companies (1-200)'),
});

export async function listCompaniesTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listCompaniesSchema.parse(args || {});
    
    const response = await client.listCompanies({
      status: params.status,
      limit: params.limit,
    });
    
    if (!response || !response.data || response.data.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No companies found matching the criteria.',
        }],
      };
    }
    
    const companiesText = response.data.filter(company => company && company.attributes).map(company => {
      const tags = company.attributes.tag_list?.length 
        ? `Tags: ${company.attributes.tag_list.join(', ')}` 
        : '';
      
      return `• ${company.attributes.name} (ID: ${company.id})
  ${company.attributes.domain ? `Domain: ${company.attributes.domain}` : 'No domain'}
  ${company.attributes.description ? `Description: ${company.attributes.description}` : ''}
  ${tags}`;
    }).join('\n\n');
    
    const summary = `Found ${response.data.length} compan${response.data.length !== 1 ? 'ies' : 'y'}${response.meta?.total_count ? ` (showing ${response.data.length} of ${response.meta.total_count})` : ''}:\n\n${companiesText}`;
    
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

export const registerCompanyTools: RegisterTools = (server, { client }) => {
  server.registerTool(
    'list_companies',
    {
      title: 'List companies',
      description: 'List companies (customers).',
      inputSchema: listCompaniesSchema,
      annotations: READ,
    },
    (args) => result(listCompaniesTool(client, args))
  );
};
