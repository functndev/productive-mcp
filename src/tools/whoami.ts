import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '../errors.js';
import { READ, result, type RegisterTools } from './context.js';

export const whoAmISchema = z.object({});

export async function whoAmI(
  client: ProductiveAPIClient,
  args: unknown,
  config?: { PRODUCTIVE_USER_ID?: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    whoAmISchema.parse(args);
    
    if (!config?.PRODUCTIVE_USER_ID) {
      return {
        content: [{
          type: 'text',
          text: 'No Productive user is linked to this sign-in, so "me" is not available.',
        }],
      };
    }
    
    // Try to get the user details from the API
    try {
      const currentUser = (await client.getPerson(config.PRODUCTIVE_USER_ID)).data;
      
      if (currentUser) {
        const fullName = `${currentUser.attributes.first_name} ${currentUser.attributes.last_name}`.trim();
        return {
          content: [{
            type: 'text',
            text: `Current user: ${fullName} (ID: ${config.PRODUCTIVE_USER_ID}, Email: ${currentUser.attributes.email})
            
When you use "me" in any command, it refers to this user.`,
          }],
        };
      }
    } catch {
      // If we can't fetch user details, just show the ID
    }
    
    return {
      content: [{
        type: 'text',
        text: `Current user ID: ${config.PRODUCTIVE_USER_ID}
        
When you use "me" in any command, it refers to this user ID.`,
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

export const registerWhoamiTools: RegisterTools = (server, { client, config }) => {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description: 'Show which Productive user "me" refers to in other tools.',
      inputSchema: whoAmISchema,
      annotations: READ,
    },
    (args) => result(whoAmI(client, args, config))
  );
};
