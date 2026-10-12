import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '../errors.js';
import { READ, WRITE, result, runSteps, type RegisterTools, type Step, type TextResult } from './context.js';

// ---- List Folders ----

export const listFoldersSchema = z.object({
  project_id: z.string().optional().describe('Only folders of this project'),
  status: z.number().int().optional().describe('1=active, 2=archived'),
  limit: z.number().int().min(1).max(200).optional().default(30).describe('Max folders (1-200)'),
});

export async function listFolders(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listFoldersSchema.parse(args || {});

    const response = await client.listFolders({
      project_id: params.project_id,
      status: params.status,
      limit: params.limit,
    });

    if (!response || !response.data || response.data.length === 0) {
      const filterText = params.project_id ? ` for project ${params.project_id}` : '';
      return {
        content: [{
          type: 'text',
          text: `No folders found${filterText}`,
        }],
      };
    }

    const foldersText = response.data.filter(folder => folder && folder.attributes).map(folder => {
      let text = `Folder: ${folder.attributes.name} (ID: ${folder.id})`;
      if (folder.attributes.position !== undefined) {
        text += `\nPosition: ${folder.attributes.position}`;
      }
      if (folder.attributes.archived_at) {
        text += `\nArchived at: ${folder.attributes.archived_at}`;
      }
      if (folder.relationships?.project?.data?.id) {
        text += `\nProject ID: ${folder.relationships.project.data.id}`;
      }
      return text;
    }).join('\n\n');

    return {
      content: [{
        type: 'text',
        text: foldersText,
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
      'Unknown error occurred while fetching folders'
    );
  }
}

// ---- Get Folder ----

export const getFolderSchema = z.object({
  folder_id: z.string().describe('Folder ID'),
});

export async function getFolder(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = getFolderSchema.parse(args || {});

    const response = await client.getFolder(params.folder_id);

    const folder = response.data;
    let text = `Folder: ${folder.attributes.name} (ID: ${folder.id})`;
    if (folder.attributes.position !== undefined) {
      text += `\nPosition: ${folder.attributes.position}`;
    }
    if (folder.attributes.archived_at) {
      text += `\nArchived at: ${folder.attributes.archived_at}`;
    }
    if (folder.attributes.hidden !== undefined) {
      text += `\nHidden: ${folder.attributes.hidden}`;
    }
    if (folder.attributes.created_at) {
      text += `\nCreated at: ${folder.attributes.created_at}`;
    }
    if (folder.attributes.updated_at) {
      text += `\nUpdated at: ${folder.attributes.updated_at}`;
    }
    if (folder.relationships?.project?.data?.id) {
      text += `\nProject ID: ${folder.relationships.project.data.id}`;
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
      'Unknown error occurred while fetching folder'
    );
  }
}

// ---- Create Folder ----

export const createFolderSchema = z.object({
  project_id: z.string().describe('Project to create the folder in'),
  name: z.string().describe('Folder name'),
});

export async function createFolder(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = createFolderSchema.parse(args || {});

    const folderData = {
      data: {
        type: 'folders' as const,
        attributes: {
          name: params.name,
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

    const response = await client.createFolder(folderData);

    let text = `Folder created successfully!\n`;
    text += `Name: ${response.data.attributes.name} (ID: ${response.data.id})`;
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
      'Unknown error occurred while creating folder'
    );
  }
}

// ---- Update Folder ----

const UpdateFolderSchema = z.object({
  folder_id: z.string().describe('The ID of the folder to update'),
  name: z.string().optional().describe('New name for the folder'),
});

export async function updateFolder(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = UpdateFolderSchema.parse(args || {});

    const folderData = {
      data: {
        type: 'folders' as const,
        id: params.folder_id,
        attributes: {
          ...(params.name !== undefined && { name: params.name }),
        },
      },
    };

    const response = await client.updateFolder(params.folder_id, folderData);

    let text = `Folder updated successfully!\n`;
    text += `Name: ${response.data.attributes.name} (ID: ${response.data.id})`;
    if (response.data.attributes.updated_at) {
      text += `\nUpdated at: ${response.data.attributes.updated_at}`;
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
      'Unknown error occurred while updating folder'
    );
  }
}

// ---- Archive Folder ----

const ArchiveFolderSchema = z.object({
  folder_id: z.string().describe('The ID of the folder to archive'),
});

export async function archiveFolder(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = ArchiveFolderSchema.parse(args || {});

    await client.archiveFolder(params.folder_id);

    return {
      content: [{
        type: 'text',
        text: `Folder ${params.folder_id} archived successfully.`,
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
      'Unknown error occurred while archiving folder'
    );
  }
}

// ---- Restore Folder ----

const RestoreFolderSchema = z.object({
  folder_id: z.string().describe('The ID of the folder to restore'),
});

export async function restoreFolder(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = RestoreFolderSchema.parse(args || {});

    await client.restoreFolder(params.folder_id);

    return {
      content: [{
        type: 'text',
        text: `Folder ${params.folder_id} restored successfully.`,
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
      'Unknown error occurred while restoring folder'
    );
  }
}

export const updateFolderSchema = z.object({
  folder_id: z.string().describe('Folder to change'),
  name: z.string().min(1).optional().describe('New name'),
  archived: z.boolean().optional().describe('true archives the folder, false restores it'),
});


/** One tool for every change to an existing folder: restore, rename, archive (in that order). */
async function updateFolderTool(client: ProductiveAPIClient, args: z.infer<typeof updateFolderSchema>): Promise<TextResult> {
  const { folder_id } = args;
  const steps: Step[] = [];

  if (args.archived === false) {
    steps.push(['restore', () => restoreFolder(client, { folder_id })]);
  }
  if (args.name !== undefined) {
    steps.push(['name', () => updateFolder(client, { folder_id, name: args.name })]);
  }
  if (args.archived === true) {
    steps.push(['archive', () => archiveFolder(client, { folder_id })]);
  }
  return runSteps(steps, 'Nothing to update: pass at least one field besides folder_id');
}

export const registerFolderTools: RegisterTools = (server, { client }) => {
  server.registerTool(
    'list_folders',
    {
      title: 'List folders',
      description: 'List folders, optionally for one project.',
      inputSchema: listFoldersSchema,
      annotations: READ,
    },
    (args) => result(listFolders(client, args))
  );
  server.registerTool(
    'get_folder',
    {
      title: 'Get folder',
      description: 'Get a folder by ID.',
      inputSchema: getFolderSchema,
      annotations: READ,
    },
    (args) => result(getFolder(client, args))
  );
  server.registerTool(
    'create_folder',
    {
      title: 'Create folder',
      description: 'Create a folder in a project.',
      inputSchema: createFolderSchema,
      annotations: WRITE,
    },
    (args) => result(createFolder(client, args))
  );
  server.registerTool(
    'update_folder',
    {
      title: 'Update folder',
      description: 'Change an existing folder: rename, archive or restore. Pass only the fields to change.',
      inputSchema: updateFolderSchema,
      annotations: WRITE,
    },
    (args) => result(updateFolderTool(client, args))
  );
};
