import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '../errors.js';
import { ProductiveIncludedResource, ProductiveAttachment } from '../api/types.js';
import { formatAttachmentList } from './attachments.js';
import { READ, WRITE, result, runSteps, type RegisterTools, type Step, type TextResult } from './context.js';


function resolvePersonName(personId: string | undefined, included?: ProductiveIncludedResource[]): string | undefined {
  if (!personId || !included) return undefined;
  const person = included.find(item => item.type === 'people' && item.id === personId);
  if (!person) return undefined;
  const first = person.attributes.first_name || '';
  const last = person.attributes.last_name || '';
  return `${first} ${last}`.trim() || undefined;
}

/**
 * Pulls the attachments belonging to one comment out of a JSON:API `included`
 * array, so comment screenshots surface with their get_attachment IDs.
 */
function resolveAttachments(
  comment: { relationships?: Record<string, any> },
  included?: ProductiveIncludedResource[]
): ProductiveAttachment[] {
  const refs = comment.relationships?.attachments?.data;
  if (!Array.isArray(refs) || !included) return [];
  return refs
    .map(ref => included.find(item => item.type === 'attachments' && item.id === ref.id))
    .filter((item): item is ProductiveIncludedResource => !!item && !item.attributes?.deleted_at)
    .map(item => item as unknown as ProductiveAttachment);
}

function truncateBody(body: string, maxLength = 200): string {
  if (body.length <= maxLength) return body;
  return body.substring(0, maxLength) + '...';
}

// ---- Add Task Comment ----

export const addTaskCommentSchema = z.object({
  task_id: z.string().min(1, 'Task ID is required'),
  comment: z.string().min(1, 'Comment text is required').describe('HTML allowed: <div>, <p>, <strong>, <em>, <ul>, <li>, <a href="">'),
});

export async function addTaskCommentTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<TextResult> {
  try {
    const params = addTaskCommentSchema.parse(args);

    const commentData = {
      data: {
        type: 'comments' as const,
        attributes: {
          body: params.comment,
        },
        relationships: {
          task: {
            data: {
              id: params.task_id,
              type: 'tasks' as const,
            },
          },
        },
      },
    };

    const response = await client.createComment(commentData);

    let text = `Comment added successfully!\n`;
    text += `Task ID: ${params.task_id}\n`;
    text += `Comment: ${response.data.attributes.body}\n`;
    text += `Comment ID: ${response.data.id}`;
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
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => e.message).join(', ')}`
      );
    }

    throw new McpError(
      ErrorCode.InternalError,
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
}

// ---- List Comments ----

export const listCommentsSchema = z.object({
  task_id: z.string().optional().describe('Only comments on this task'),
  project_id: z.string().optional().describe('Only comments in this project'),
  limit: z.number().int().min(1).optional().describe('Max comments'),
});

export async function listCommentsTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<TextResult> {
  try {
    const params = listCommentsSchema.parse(args);

    const response = await client.listComments({
      task_id: params.task_id,
      project_id: params.project_id,
      limit: params.limit,
    });

    if (!response.data || response.data.length === 0) {
      return {
        content: [{ type: 'text', text: 'No comments found.' }],
      };
    }

    const commentsText = response.data.map(comment => {
      const creatorId = comment.relationships?.creator?.data?.id;
      const creatorName = resolvePersonName(creatorId, response.included) || `Person ${creatorId || 'unknown'}`;
      const pinned = comment.attributes.pinned_at ? ' [PINNED]' : '';
      const body = truncateBody(comment.attributes.body);

      const attachments = resolveAttachments(comment, response.included);
      const attachmentsText = attachments.length
        ? `\n  Attachments (${attachments.length}) - read with get_attachment:\n${formatAttachmentList(attachments).split('\n').map(line => `  ${line}`).join('\n')}`
        : '';

      return `- Comment ID: ${comment.id}${pinned}\n  By: ${creatorName}\n  Date: ${comment.attributes.created_at}\n  Body: ${body}${attachmentsText}`;
    }).join('\n\n');

    return {
      content: [{ type: 'text', text: `Comments (${response.data.length}):\n\n${commentsText}` }],
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

// ---- Get Comment ----

export const getCommentSchema = z.object({
  comment_id: z.string().min(1, 'Comment ID is required'),
});

export async function getCommentTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<TextResult> {
  try {
    const params = getCommentSchema.parse(args);

    const response = await client.getComment(params.comment_id);
    const comment = response.data;
    const attrs = comment.attributes;

    const creatorId = comment.relationships?.creator?.data?.id;
    const included = (response as unknown as { included?: ProductiveIncludedResource[] }).included;
    const creatorName = resolvePersonName(creatorId, included) || `Person ${creatorId || 'unknown'}`;

    let text = `Comment ID: ${comment.id}\n`;
    text += `Body: ${attrs.body}\n`;
    text += `Commentable Type: ${attrs.commentable_type}\n`;
    text += `Creator: ${creatorName}\n`;
    text += `Created: ${attrs.created_at}\n`;
    text += `Updated: ${attrs.updated_at}\n`;
    if (attrs.edited_at) text += `Edited: ${attrs.edited_at}\n`;
    if (attrs.deleted_at) text += `Deleted: ${attrs.deleted_at}\n`;
    text += `Draft: ${attrs.draft ?? false}\n`;
    text += `Hidden: ${attrs.hidden ?? false}\n`;
    text += `Pinned: ${attrs.pinned_at ? `Yes (${attrs.pinned_at})` : 'No'}\n`;
    if (attrs.reactions) text += `Reactions: ${JSON.stringify(attrs.reactions)}\n`;
    if (attrs.version_number !== undefined) text += `Version: ${attrs.version_number}\n`;

    const attachments = resolveAttachments(comment, included);
    if (attachments.length > 0) {
      text += `\nAttachments (${attachments.length}) - use get_attachment with the attachment ID to read one:\n`;
      text += `${formatAttachmentList(attachments)}\n`;
    }

    return {
      content: [{ type: 'text', text }],
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

// ---- Update Comment ----

const updateCommentBodySchema = z.object({
  comment_id: z.string().min(1, 'Comment ID is required'),
  body: z.string().min(1, 'Comment body is required'),
});

async function updateCommentBodyTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<TextResult> {
  try {
    const params = updateCommentBodySchema.parse(args);

    const response = await client.updateComment(params.comment_id, {
      data: {
        type: 'comments',
        id: params.comment_id,
        attributes: {
          body: params.body,
        },
      },
    });

    return {
      content: [{
        type: 'text',
        text: `Comment ${params.comment_id} updated successfully.\nNew body: ${response.data.attributes.body}`,
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

// ---- Delete Comment ----

const deleteCommentSchema = z.object({
  comment_id: z.string().min(1, 'Comment ID is required'),
});

export async function deleteCommentTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<TextResult> {
  try {
    const params = deleteCommentSchema.parse(args);

    await client.deleteComment(params.comment_id);

    return {
      content: [{
        type: 'text',
        text: `Comment ${params.comment_id} deleted successfully.`,
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

// ---- Pin Comment ----

const pinCommentSchema = z.object({
  comment_id: z.string().min(1, 'Comment ID is required'),
});

async function pinCommentTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<TextResult> {
  try {
    const params = pinCommentSchema.parse(args);

    await client.pinComment(params.comment_id);

    return {
      content: [{
        type: 'text',
        text: `Comment ${params.comment_id} pinned successfully.`,
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

// ---- Unpin Comment ----

const unpinCommentSchema = z.object({
  comment_id: z.string().min(1, 'Comment ID is required'),
});

async function unpinCommentTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<TextResult> {
  try {
    const params = unpinCommentSchema.parse(args);

    await client.unpinComment(params.comment_id);

    return {
      content: [{
        type: 'text',
        text: `Comment ${params.comment_id} unpinned successfully.`,
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

// ---- Add Comment Reaction ----

export const addCommentReactionSchema = z.object({
  comment_id: z.string().min(1, 'Comment ID is required'),
  reaction: z.string().min(1, 'Reaction is required').describe('e.g. "like", "heart", "thumbsup"'),
});

export async function addCommentReactionTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<TextResult> {
  try {
    const params = addCommentReactionSchema.parse(args);

    await client.addCommentReaction(params.comment_id, params.reaction);

    return {
      content: [{
        type: 'text',
        text: `Reaction "${params.reaction}" added to comment ${params.comment_id} successfully.`,
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

// ---- Update Comment (body and/or pin state) ----

export const updateCommentSchema = z.object({
  comment_id: z.string().min(1, 'Comment ID is required'),
  body: z.string().min(1, 'Comment body cannot be empty').optional().describe('New body (replaces the old one); HTML allowed'),
  pinned: z.boolean().optional().describe('true pins the comment, false unpins it'),
});

/** One tool for every change to a comment: the body first, then the pin state. */
async function updateCommentTool(client: ProductiveAPIClient, args: z.infer<typeof updateCommentSchema>): Promise<TextResult> {
  const { comment_id } = args;
  const steps: Step[] = [];

  if (args.body !== undefined) {
    steps.push(['body', () => updateCommentBodyTool(client, { comment_id, body: args.body })]);
  }
  if (args.pinned !== undefined) {
    steps.push([args.pinned ? 'pin' : 'unpin', () => (args.pinned ? pinCommentTool : unpinCommentTool)(client, { comment_id })]);
  }
  return runSteps(steps, 'Nothing to update: pass body and/or pinned');
}

export const registerCommentTools: RegisterTools = (server, { client }) => {
  server.registerTool(
    'list_comments',
    {
      title: 'List comments',
      description: 'List comments with their attachments, optionally of one task or project.',
      inputSchema: listCommentsSchema,
      annotations: READ,
    },
    (args) => result(listCommentsTool(client, args))
  );
  server.registerTool(
    'get_comment',
    {
      title: 'Get comment',
      description: 'Get a comment with its full body, creator, pin state, reactions and attachments.',
      inputSchema: getCommentSchema,
      annotations: READ,
    },
    (args) => result(getCommentTool(client, args))
  );
  server.registerTool(
    'add_task_comment',
    {
      title: 'Add task comment',
      description: 'Add a comment to a task. HTML formatting is supported.',
      inputSchema: addTaskCommentSchema,
      annotations: WRITE,
    },
    (args) => result(addTaskCommentTool(client, args))
  );
  server.registerTool(
    'update_comment',
    {
      title: 'Update comment',
      description: 'Change a comment\'s body and/or pin or unpin it. Pass only the fields to change.',
      inputSchema: updateCommentSchema,
      annotations: WRITE,
    },
    (args) => result(updateCommentTool(client, args))
  );
  server.registerTool(
    'add_comment_reaction',
    {
      title: 'Add comment reaction',
      description: 'Add a reaction (e.g. "like") to a comment.',
      inputSchema: addCommentReactionSchema,
      annotations: WRITE,
    },
    (args) => result(addCommentReactionTool(client, args))
  );
};
