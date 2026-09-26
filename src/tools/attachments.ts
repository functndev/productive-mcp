import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ProductiveAttachment } from '../api/types.js';

/**
 * Tool results may carry binary payloads, so they are not limited to the
 * `{ type: 'text' }` blocks the other tools return.
 */
type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } };

type ToolResult = { content: ToolContent[] };

/** Raw bytes above this are refused (base64 inflates them by ~33%). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Text attachments are truncated past this point. */
const MAX_TEXT_BYTES = 200 * 1024;
/** Other files are returned raw, capped like images. */
const MAX_RAW_BYTES = MAX_IMAGE_BYTES;

function formatSize(bytes: number | undefined): string {
  if (typeof bytes !== 'number') return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(contentType: string | undefined): boolean {
  return !!contentType?.startsWith('image/');
}

function isTextLike(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return (
    contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    contentType === 'application/xml' ||
    contentType === 'application/javascript' ||
    contentType.endsWith('+json') ||
    contentType.endsWith('+xml')
  );
}

/** btoa() over a whole file would blow the argument limit, so chunk it. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function describeAttachment(attachment: ProductiveAttachment): string {
  const a = attachment.attributes;
  const kind = isImage(a.content_type)
    ? 'image'
    : isTextLike(a.content_type)
      ? 'text'
      : 'binary';
  let line = `• ${a.name} (attachment ID: ${attachment.id})\n`;
  line += `  Type: ${a.content_type || 'unknown'} (${kind}) · Size: ${formatSize(a.size)}\n`;
  if (a.created_at) line += `  Created: ${a.created_at}\n`;
  if (a.attachable_type) line += `  Attached to: ${a.attachable_type}\n`;
  line += `  URL: ${a.url}\n`;
  line += `  Readable: call get_attachment with attachment_id ${attachment.id} to ${
    kind === 'image' ? 'view it' : 'read its contents'
  }`;
  return line;
}

/**
 * Renders the attachments of a task/comment/page as a text block. Used by
 * `list_attachments` and inlined into `get_task` so a ticket read surfaces its
 * screenshots without a second round trip.
 */
export function formatAttachmentList(attachments: ProductiveAttachment[]): string {
  return attachments.map(describeAttachment).join('\n\n');
}

const listAttachmentsSchema = z
  .object({
    task_id: z.string().optional(),
    comment_id: z.string().optional(),
    page_id: z.string().optional(),
    project_id: z.string().optional(),
    limit: z.number().min(1).max(200).default(50).optional(),
    page: z.number().min(1).default(1).optional(),
  })
  .refine(
    params =>
      !!(params.task_id || params.comment_id || params.page_id || params.project_id),
    {
      message:
        'One of task_id, comment_id, page_id or project_id is required',
    }
  );

export async function listAttachmentsTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<ToolResult> {
  try {
    const params = listAttachmentsSchema.parse(args || {});

    const response = await client.listAttachments({
      task_id: params.task_id,
      comment_id: params.comment_id,
      page_id: params.page_id,
      project_id: params.project_id,
      limit: params.limit ?? 50,
      page: params.page ?? 1,
    });

    const scope = params.task_id
      ? `task ${params.task_id}`
      : params.comment_id
        ? `comment ${params.comment_id}`
        : params.page_id
          ? `page ${params.page_id}`
          : `project ${params.project_id}`;

    const attachments = (response.data ?? []).filter(a => !a.attributes?.deleted_at);

    if (attachments.length === 0) {
      return {
        content: [{ type: 'text', text: `No attachments found for ${scope}.` }],
      };
    }

    const total = response.meta?.total_count;
    const header = `Found ${attachments.length} attachment${attachments.length !== 1 ? 's' : ''} for ${scope}${
      total ? ` (showing ${attachments.length} of ${total})` : ''
    }:`;

    return {
      content: [
        { type: 'text', text: `${header}\n\n${formatAttachmentList(attachments)}` },
      ],
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

export const listAttachmentsDefinition = {
  name: 'list_attachments',
  description:
    'List the files attached to a task, comment, page or project in Productive.io (screenshots, PDFs, logs). Returns each attachment ID, filename, MIME type and size. Use get_attachment to actually read an attachment. Note that images embedded in a task description are attachments too, so a ticket whose description contains a screenshot will list it here.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'List attachments of this task (including images embedded in its description)',
      },
      comment_id: {
        type: 'string',
        description: 'List attachments of this comment',
      },
      page_id: {
        type: 'string',
        description: 'List attachments of this page',
      },
      project_id: {
        type: 'string',
        description: 'List all attachments in this project',
      },
      limit: {
        type: 'number',
        description: 'Number of attachments to return (1-200, default: 50)',
        minimum: 1,
        maximum: 200,
        default: 50,
      },
      page: {
        type: 'number',
        description: 'Page number for pagination (default: 1)',
        minimum: 1,
        default: 1,
      },
    },
  },
};

const getAttachmentSchema = z.object({
  attachment_id: z.string().min(1, 'Attachment ID is required'),
  thumbnail: z.boolean().default(false).optional(),
});

export async function getAttachmentTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<ToolResult> {
  try {
    const params = getAttachmentSchema.parse(args || {});

    const response = await client.getAttachment(params.attachment_id);
    const attachment = response.data;
    const a = attachment.attributes;
    const label = `${a.name} (attachment ID: ${attachment.id}, ${a.content_type || 'unknown type'}, ${formatSize(a.size)})`;

    if (a.deleted_at) {
      return {
        content: [{ type: 'text', text: `Attachment ${label} has been deleted.` }],
      };
    }

    if (isImage(a.content_type)) {
      // Fall back to the resized preview when the original is too large to
      // return inline, so an oversized screenshot is still readable.
      const wantsThumb = params.thumbnail === true;
      const tooLarge = typeof a.size === 'number' && a.size > MAX_IMAGE_BYTES;
      const useThumb = (wantsThumb || tooLarge) && !!a.thumb;

      if (tooLarge && !a.thumb) {
        throw new Error(
          `Attachment ${label} is larger than the ${formatSize(MAX_IMAGE_BYTES)} inline limit and has no thumbnail available. Open it in Productive instead: ${a.url}`
        );
      }

      const { bytes, contentType } = await client.downloadAttachmentFile(
        useThumb ? (a.thumb as string) : a.url
      );

      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(
          `Attachment ${label} is ${formatSize(bytes.byteLength)}, above the ${formatSize(MAX_IMAGE_BYTES)} inline limit. Retry with thumbnail: true, or open it in Productive: ${a.url}`
        );
      }

      const note = useThumb
        ? `${label}${tooLarge && !wantsThumb ? ' — original exceeds the inline size limit, showing the thumbnail' : ' — thumbnail'}:`
        : `${label}:`;

      return {
        content: [
          { type: 'text', text: note },
          {
            type: 'image',
            data: toBase64(bytes),
            mimeType: contentType?.split(';')[0] || a.content_type || 'image/png',
          },
        ],
      };
    }

    if (isTextLike(a.content_type)) {
      const { bytes } = await client.downloadAttachmentFile(a.url);
      const truncated = bytes.byteLength > MAX_TEXT_BYTES;
      const slice = truncated ? bytes.slice(0, MAX_TEXT_BYTES) : bytes;
      const text = new TextDecoder().decode(slice);
      return {
        content: [
          {
            type: 'text',
            text: `${label}:\n\n${text}${truncated ? `\n\n[truncated at ${formatSize(MAX_TEXT_BYTES)}]` : ''}`,
          },
        ],
      };
    }

    // Anything else (PDFs, Office documents, archives, ...) is returned as
    // an embedded resource. Claude Code saves it to disk and hands Claude the
    // path, so Claude can open it with its own file reader.
    if (typeof a.size === 'number' && a.size > MAX_RAW_BYTES) {
      throw new Error(
        `Attachment ${label} is larger than the ${formatSize(MAX_RAW_BYTES)} limit for returning the file. Open it in Productive instead: ${a.url}`
      );
    }

    const { bytes, contentType } = await client.downloadAttachmentFile(a.url);

    if (bytes.byteLength > MAX_RAW_BYTES) {
      throw new Error(
        `Attachment ${label} is ${formatSize(bytes.byteLength)}, above the ${formatSize(MAX_RAW_BYTES)} limit for returning the file. Open it in Productive instead: ${a.url}`
      );
    }

    return {
      content: [
        { type: 'text', text: `${label}:` },
        {
          type: 'resource',
          resource: {
            uri: a.url,
            mimeType:
              a.content_type || contentType?.split(';')[0] || 'application/octet-stream',
            blob: toBase64(bytes),
          },
        },
      ],
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

export const getAttachmentDefinition = {
  name: 'get_attachment',
  description:
    'Download a Productive.io attachment of any type by ID and return its contents. Images (screenshots, mockups) come back as viewable image content, text-based files as text, and anything else (PDFs, Office documents, ...) as the original file (embedded resource, max 5 MB). Get attachment IDs from list_attachments or from the Attachments section of get_task. Use this whenever a ticket references a screenshot, guide, spec or other file you need to read.',
  inputSchema: {
    type: 'object',
    properties: {
      attachment_id: {
        type: 'string',
        description: 'The ID of the attachment to download (required)',
      },
      thumbnail: {
        type: 'boolean',
        description:
          'For images, return the smaller resized preview instead of the original. Useful for very large screenshots (default: false)',
        default: false,
      },
    },
    required: ['attachment_id'],
  },
};
