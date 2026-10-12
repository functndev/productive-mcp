import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '../errors.js';
import { READ, WRITE, result, type RegisterTools } from './context.js';

export const listBoardsSchema = z.object({
  project_id: z.string().optional().describe('Only boards of this project'),
  limit: z.number().int().min(1).max(200).optional().default(30).describe('Max boards (1-200)'),
});

export async function listBoards(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listBoardsSchema.parse(args || {});
    
    const response = await client.listBoards({
      project_id: params.project_id,
      limit: params.limit,
    });
    
    // Add defensive checks for response structure
    if (!response || !response.data || response.data.length === 0) {
      const filterText = params.project_id ? ` for project ${params.project_id}` : '';
      return {
        content: [{
          type: 'text',
          text: `No boards found${filterText}`,
        }],
      };
    }
    
    const boardsText = response.data.filter(board => board && board.attributes).map(board => {
      let text = `Board: ${board.attributes.name} (ID: ${board.id})`;
      if (board.attributes.description) {
        text += `\nDescription: ${board.attributes.description}`;
      }
      if (board.attributes.position !== undefined) {
        text += `\nPosition: ${board.attributes.position}`;
      }
      if (board.relationships?.project?.data?.id) {
        text += `\nProject ID: ${board.relationships.project.data.id}`;
      }
      return text;
    }).join('\n\n');
    
    return {
      content: [{
        type: 'text',
        text: boardsText,
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
      'Unknown error occurred while fetching boards'
    );
  }
}

export const createBoardSchema = z.object({
  project_id: z.string().describe('Project to create the board in'),
  name: z.string().describe('Board name'),
  description: z.string().optional().describe('Board description'),
});

export async function createBoard(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = createBoardSchema.parse(args || {});
    
    const boardData = {
      data: {
        type: 'boards' as const,
        attributes: {
          name: params.name,
          description: params.description,
        },
        relationships: {
          project: {
            data: {
              id: params.project_id,
              type: 'projects' as const,
            },
          },
        },
      },
    };
    
    const response = await client.createBoard(boardData);
    
    let text = `Board created successfully!\n`;
    text += `Name: ${response.data.attributes.name} (ID: ${response.data.id})`;
    if (response.data.attributes.description) {
      text += `\nDescription: ${response.data.attributes.description}`;
    }
    text += `\nProject ID: ${params.project_id}`;
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
      'Unknown error occurred while creating board'
    );
  }
}

export const registerBoardTools: RegisterTools = (server, { client }) => {
  server.registerTool(
    'list_boards',
    {
      title: 'List boards',
      description: 'List boards, optionally for one project. Boards hold task lists.',
      inputSchema: listBoardsSchema,
      annotations: READ,
    },
    (args) => result(listBoards(client, args))
  );
  server.registerTool(
    'create_board',
    {
      title: 'Create board',
      description: 'Create a board in a project.',
      inputSchema: createBoardSchema,
      annotations: WRITE,
    },
    (args) => result(createBoard(client, args))
  );
};
