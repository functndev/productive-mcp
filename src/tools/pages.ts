import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import type { ProductivePage } from '../api/types.js';
import { McpError, ErrorCode } from '../errors.js';
import { READ, WRITE, result, runSteps, type RegisterTools, type Step, type TextResult } from './context.js';

// ---- Schemas ----

const PAGE_SORTS = ['created_at', 'title', 'edited_at', 'updated_at'] as const;
// `position` is the display order among siblings; the API can't sort by it, so it is sorted here.
const PAGE_SORT_OPTIONS = [...PAGE_SORTS, ...PAGE_SORTS.map(s => `-${s}` as const), 'position'] as const;

// Productive shows sibling pages by ascending `position` (lowest on top), unpositioned (null) pages last.
function byPosition(a: ProductivePage, b: ProductivePage): number {
  return (a.attributes.position ?? Number.MAX_SAFE_INTEGER) - (b.attributes.position ?? Number.MAX_SAFE_INTEGER);
}

export const listPagesSchema = z.object({
  project_id: z.string().optional().describe('Only pages of this project'),
  parent_page_id: z.string().optional().describe('Only direct sub-pages of this page'),
  root_page_id: z.string().optional().describe('All pages in the tree below this root page (any depth)'),
  sort: z.enum(PAGE_SORT_OPTIONS).optional().describe('Prefix with "-" for descending (e.g. "-created_at" = newest first). "position" returns siblings in the order Productive shows them (top first); combine it with parent_page_id.'),
  limit: z.number().int().min(1).max(200).default(30).optional().describe('Max pages (1-200, default 30)'),
});

export const getPageSchema = z.object({
  page_id: z.string().min(1, 'Page ID is required'),
});

// Productive only accepts a project on root pages; sub-pages inherit it from their root.
export const createPageSchema = z.object({
  project_id: z.string().min(1).optional().describe('Required for root pages; omit for sub-pages, which inherit the project of their root page'),
  title: z.string().min(1, 'Title is required'),
  body: z.string().optional().describe('Markdown'),
  parent_page_id: z.number().optional().describe('Parent page to nest this page under; set together with root_page_id'),
  root_page_id: z.number().optional().describe('Top-level page of the hierarchy; set together with parent_page_id (for direct children of the root, both are the root page ID)'),
})
  .refine(p => (p.parent_page_id == null) === (p.root_page_id == null), {
    message: 'parent_page_id and root_page_id must be set together',
  })
  .refine(p => p.parent_page_id != null || p.project_id, {
    message: 'project_id is required for a root page (no parent_page_id)',
  });

const updatePageDetailsSchema = z.object({
  page_id: z.string().min(1, 'Page ID is required'),
  title: z.string().optional(),
  body: z.string().optional(),
  position: z.number().int().min(0).optional(),
});

const reorderPagesSchema = z.object({
  parent_page_id: z.string().min(1, 'Parent page ID is required'),
  page_ids: z.array(z.string().min(1)).min(1, 'At least one page ID is required')
    .refine(ids => new Set(ids).size === ids.length, 'page_ids must not contain duplicates'),
});

const deletePageSchema = z.object({
  page_id: z.string().min(1, 'Page ID is required'),
});

const movePageSchema = z.object({
  page_id: z.string().min(1, 'Page ID is required'),
  target_doc_id: z.string().min(1, 'Target document ID is required'),
});

export const copyPageSchema = z.object({
  template_id: z.string().min(1, 'Template ID (page to copy) is required').describe('ID of the page to copy'),
  project_id: z.string().optional().describe('Project to copy the page into (default: same project)'),
});

// ---- Handlers ----

export async function listPagesTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listPagesSchema.parse(args || {});

    const response = await client.listPages({
      project_id: params.project_id,
      parent_page_id: params.parent_page_id,
      root_page_id: params.root_page_id,
      sort: params.sort === 'position' ? undefined : params.sort,
      limit: params.limit,
    });
    if (params.sort === 'position' && response?.data) response.data.sort(byPosition);

    if (!response || !response.data || response.data.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No pages found matching the criteria.',
        }],
      };
    }

    const pagesText = response.data.filter(page => page && page.attributes).map(page => {
      const projectId = page.relationships?.project?.data?.id;
      return `• ${page.attributes.title} (ID: ${page.id})
  ${projectId ? `Project ID: ${projectId}` : ''}
  ${page.attributes.parent_page_id != null ? `Parent page ID: ${page.attributes.parent_page_id}` : ''}
  ${page.attributes.position != null ? `Position: ${page.attributes.position}` : ''}
  ${page.attributes.created_at ? `Created at: ${page.attributes.created_at}` : ''}
  ${page.attributes.edited_at ? `Edited at: ${page.attributes.edited_at}` : ''}
  ${page.attributes.version_number != null ? `Version: ${page.attributes.version_number}` : ''}`;
    }).join('\n\n');

    const summary = `Found ${response.data.length} page${response.data.length !== 1 ? 's' : ''}${response.meta?.total_count ? ` (showing ${response.data.length} of ${response.meta.total_count})` : ''}:\n\n${pagesText}`;

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

export async function getPageTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = getPageSchema.parse(args);
    const response = await client.getPage(params.page_id);
    const page = response.data;

    const creatorId = page.relationships?.creator?.data?.id;
    const creatorResource = creatorId && response.included
      ? response.included.find((item: { type: string; id: string }) => item.type === 'people' && item.id === creatorId)
      : undefined;
    const creatorName = creatorResource
      ? `${creatorResource.attributes.first_name || ''} ${creatorResource.attributes.last_name || ''}`.trim()
      : undefined;

    const projectId = page.relationships?.project?.data?.id;
    const projectResource = projectId && response.included
      ? response.included.find((item: { type: string; id: string }) => item.type === 'projects' && item.id === projectId)
      : undefined;
    const projectName = projectResource?.attributes?.name;

    let text = `Page: ${page.attributes.title} (ID: ${page.id})\n`;
    if (projectName) text += `Project: ${projectName} (ID: ${projectId})\n`;
    else if (projectId) text += `Project ID: ${projectId}\n`;
    if (creatorName) text += `Creator: ${creatorName}\n`;
    if (page.attributes.public_access != null) text += `Public access: ${page.attributes.public_access}\n`;
    if (page.attributes.version_number != null) text += `Version: ${page.attributes.version_number}\n`;
    if (page.attributes.parent_page_id != null) text += `Parent page ID: ${page.attributes.parent_page_id}\n`;
    if (page.attributes.root_page_id != null) text += `Root page ID: ${page.attributes.root_page_id}\n`;
    text += `Created at: ${page.attributes.created_at}\n`;
    text += `Updated at: ${page.attributes.updated_at}\n`;
    if (page.attributes.edited_at) text += `Edited at: ${page.attributes.edited_at}\n`;
    if (page.attributes.last_activity_at) text += `Last activity at: ${page.attributes.last_activity_at}\n`;
    text += `\nBody:\n${page.attributes.body || '(empty)'}`;

    return {
      content: [{
        type: 'text',
        text,
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

export async function createPageTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = createPageSchema.parse(args);

    const response = await client.createPage({
      data: {
        type: 'pages',
        attributes: {
          title: params.title,
          parent_page_id: params.parent_page_id,
          root_page_id: params.root_page_id,
        },
        ...(params.parent_page_id == null && params.project_id
          ? { relationships: { project: { data: { id: params.project_id, type: 'projects' } } } }
          : {}),
      },
    });

    const page = response.data;

    // The body goes through the markdown endpoint for the same reason as in updatePageDetailsTool.
    if (params.body !== undefined) {
      try {
        await client.replacePageBodyWithMarkdown(page.id, params.body);
      } catch (error) {
        throw new Error(
          `Page ${page.id} was created, but setting its body failed: ` +
          `${error instanceof Error ? error.message : String(error)}. Retry with update_page.`,
          { cause: error },
        );
      }
    }

    let text = `Page created successfully!\n`;
    text += `Title: ${page.attributes.title}\n`;
    text += `Page ID: ${page.id}\n`;
    if (params.parent_page_id == null) text += `Project ID: ${params.project_id}\n`;
    if (params.parent_page_id != null) text += `Parent page ID: ${params.parent_page_id}\n`;
    text += `Created at: ${page.attributes.created_at}`;

    return {
      content: [{
        type: 'text',
        text,
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

async function updatePageDetailsTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = updatePageDetailsSchema.parse(args);

    const attributes: { title?: string; position?: number } = {};
    if (params.title !== undefined) attributes.title = params.title;
    if (params.position !== undefined) attributes.position = params.position;

    // PATCHing `body` directly is undone as soon as someone has the page open: the editor
    // saves its own copy back over it. The markdown endpoint replaces that copy as well.
    let response = params.body !== undefined
      ? await client.replacePageBodyWithMarkdown(params.page_id, params.body)
      : undefined;
    if (Object.keys(attributes).length || !response) {
      response = await client.updatePage(params.page_id, {
        data: {
          type: 'pages',
          id: params.page_id,
          attributes,
        },
      });
    }

    const page = response.data;

    let text = `Page updated successfully!\n`;
    text += `Title: ${page.attributes.title}\n`;
    text += `Page ID: ${page.id}\n`;
    if (page.attributes.position != null) text += `Position: ${page.attributes.position}\n`;
    text += `Updated at: ${page.attributes.updated_at}`;

    return {
      content: [{
        type: 'text',
        text,
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

export async function deletePageTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = deletePageSchema.parse(args);
    await client.deletePage(params.page_id);

    return {
      content: [{
        type: 'text',
        text: `Page ${params.page_id} deleted successfully.`,
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

async function movePageTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = movePageSchema.parse(args);
    await client.movePage(params.page_id, params.target_doc_id);

    return {
      content: [{
        type: 'text',
        text: `Page ${params.page_id} moved under document ${params.target_doc_id} successfully.`,
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

/**
 * Put the direct sub-pages of a page in the given order by writing contiguous positions (0 = top).
 * Children not named in page_ids keep their current relative order below the named ones.
 */
async function reorderPagesTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = reorderPagesSchema.parse(args);

    const children: ProductivePage[] = [];
    for (let pageNumber = 1; ; pageNumber++) {
      const response = await client.listPages({ parent_page_id: params.parent_page_id, limit: 200, page: pageNumber });
      children.push(...(response.data ?? []));
      if ((response.data?.length ?? 0) < 200) break;
    }

    const byId = new Map(children.map(p => [p.id, p]));
    const unknown = params.page_ids.filter(id => !byId.has(id));
    if (unknown.length > 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Not direct sub-pages of ${params.parent_page_id}: ${unknown.join(', ')}`
      );
    }

    const named = new Set(params.page_ids);
    const rest = children.filter(p => !named.has(p.id)).sort(byPosition);
    const desired = [...params.page_ids.map(id => byId.get(id)!), ...rest];

    let writes = 0;
    for (const [position, page] of desired.entries()) {
      if (page.attributes.position === position) continue;
      await client.updatePage(page.id, { data: { type: 'pages', id: page.id, attributes: { position } } });
      writes++;
    }

    const lines = desired.map((p, i) => `${String(i).padStart(3)}. ${p.attributes.title} (ID: ${p.id})`);
    return {
      content: [{
        type: 'text',
        text: `Reordered ${desired.length} sub-pages of ${params.parent_page_id} (${writes} position write${writes !== 1 ? 's' : ''}), top first:\n${lines.join('\n')}`,
      }],
    };
  } catch (error) {
    if (error instanceof McpError) throw error;
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

export async function copyPageTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = copyPageSchema.parse(args);
    const response = await client.copyPage(params.template_id, params.project_id);
    const page = response.data;

    let text = `Page copied successfully!\n`;
    text += `Title: ${page.attributes.title}\n`;
    text += `New page ID: ${page.id}\n`;
    text += `Created at: ${page.attributes.created_at}`;

    return {
      content: [{
        type: 'text',
        text,
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

export const updatePageSchema = z.object({
  page_id: z.string().min(1, 'Page ID is required'),
  title: z.string().optional(),
  body: z.string().optional().describe('New body as Markdown. Replaces the whole body; anything Markdown can\'t express (mentions, banners, colours) is lost.'),
  position: z.number().int().min(0).optional().describe('Display position among its siblings (0 = top); to order all siblings, use subpage_order on their parent'),
  parent_page_id: z.string().min(1).optional().describe('Move the page under this page'),
  subpage_order: z.array(z.string().min(1)).min(1).optional().describe('IDs of this page\'s direct sub-pages in the desired order, top first; sub-pages left out keep their relative order below them'),
});


/**
 * One tool for every change to an existing page. Each requested change runs the dedicated
 * implementation, in this order: move, title/body/position, sub-page order.
 */
async function updatePageTool(client: ProductiveAPIClient, args: z.infer<typeof updatePageSchema>): Promise<TextResult> {
  const { page_id } = args;
  const steps: Step[] = [];

  if (args.parent_page_id !== undefined) {
    steps.push(['move', () => movePageTool(client, { page_id, target_doc_id: args.parent_page_id })]);
  }
  if (args.title !== undefined || args.body !== undefined || args.position !== undefined) {
    steps.push(['title/body/position', () => updatePageDetailsTool(client, { page_id, title: args.title, body: args.body, position: args.position })]);
  }
  if (args.subpage_order !== undefined) {
    steps.push(['sub-page order', () => reorderPagesTool(client, { parent_page_id: page_id, page_ids: args.subpage_order })]);
  }
  return runSteps(steps, 'Nothing to update: pass at least one field besides page_id');
}

export const registerPageTools: RegisterTools = (server, { client }) => {
  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description: 'List pages (docs) by project, parent page (direct sub-pages) or root page (whole tree).',
      inputSchema: listPagesSchema,
      annotations: READ,
    },
    (args) => result(listPagesTool(client, args))
  );
  server.registerTool(
    'get_page',
    {
      title: 'Get page',
      description: 'Get a page (doc) with its full body, creator and project.',
      inputSchema: getPageSchema,
      annotations: READ,
    },
    (args) => result(getPageTool(client, args))
  );
  server.registerTool(
    'create_page',
    {
      title: 'Create page',
      description: 'Create a page (doc), as a root page in a project or as a sub-page. The body is Markdown.',
      inputSchema: createPageSchema,
      annotations: WRITE,
    },
    (args) => result(createPageTool(client, args))
  );
  server.registerTool(
    'update_page',
    {
      title: 'Update page',
      description: 'Change a page: title, Markdown body, position, move it under another page, or reorder its sub-pages. Pass only the fields to change.',
      inputSchema: updatePageSchema,
      annotations: WRITE,
    },
    (args) => result(updatePageTool(client, args))
  );
  server.registerTool(
    'copy_page',
    {
      title: 'Copy page',
      description: 'Copy a page (e.g. a template), optionally into another project.',
      inputSchema: copyPageSchema,
      annotations: WRITE,
    },
    (args) => result(copyPageTool(client, args))
  );
};
