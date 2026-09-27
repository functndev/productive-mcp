import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ProductiveDeal, ProductiveIncludedResource } from '../api/types.js';

// ---- Schemas ----

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const SALES_STATUSES = { open: 1, won: 2, lost: 3, delivered: 4 } as const;
const SALES_STATUS_NAMES: Record<number, string> = { 1: 'open', 2: 'won', 3: 'lost', 4: 'delivered' };

const listDealsSchema = z.object({
  since: isoDate,
  created_only: z.boolean().default(false).optional(),
  include_budgets: z.boolean().default(false).optional(),
  sales_status: z.enum(['open', 'won', 'lost', 'delivered']).optional(),
  company_id: z.string().optional(),
  responsible_id: z.string().optional(),
});

const MAX_API_PAGES = 5;

// ---- Handlers ----

export async function listDealsTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listDealsSchema.parse(args);

    const deals: ProductiveDeal[] = [];
    const included = new Map<string, ProductiveIncludedResource>();
    for (let page = 1; page <= MAX_API_PAGES; page++) {
      const response = await client.listDeals({
        active_since: params.created_only ? undefined : params.since,
        created_since: params.created_only ? params.since : undefined,
        type: params.include_budgets ? undefined : 1,
        sales_status_id: params.sales_status ? SALES_STATUSES[params.sales_status] : undefined,
        company_id: params.company_id,
        responsible_id: params.responsible_id,
        sort: '-last_activity_at',
        limit: 200,
        page,
      });
      deals.push(...(response.data ?? []));
      for (const inc of response.included ?? []) included.set(`${inc.type}:${inc.id}`, inc);
      if (page >= (response.meta?.total_pages ?? 1)) break;
    }

    const lookup = (type: string, id?: string | null) => (id ? included.get(`${type}:${id}`) : undefined);
    const relId = (d: ProductiveDeal, name: string): string | undefined => d.relationships?.[name]?.data?.id;
    const onOrAfter = (ts: unknown) => typeof ts === 'string' && ts.slice(0, 10) >= params.since;

    const rows = deals.map(d => {
      const a = d.attributes;
      const responsible = lookup('people', relId(d, 'responsible'));
      const stage = lookup('deal_statuses', relId(d, 'deal_status'));
      // deals carry no sales_status_id or won_at/lost_at: the stage's status_id says open/won/lost,
      // sales_closed_at when it closed, and sales_status_updated_at when the stage last changed
      const salesStatus = SALES_STATUS_NAMES[stage?.attributes?.status_id] ?? null;
      const closedSince = onOrAfter(a.sales_closed_at);
      // what happened since `since`, most significant first
      const changes: string[] = [];
      if (closedSince && salesStatus === 'won') changes.push('won');
      if (closedSince && salesStatus === 'lost') changes.push('lost');
      if (onOrAfter(a.created_at)) changes.push('created');
      if (onOrAfter(a.sales_status_updated_at)) changes.push('stage_changed');
      if (!changes.length) changes.push('updated');
      return {
        deal_id: d.id,
        name: a.name,
        number: a.number ?? a.deal_number ?? null,
        company: lookup('companies', relId(d, 'company'))?.attributes?.name ?? null,
        responsible: responsible
          ? `${responsible.attributes.first_name ?? ''} ${responsible.attributes.last_name ?? ''}`.trim()
          : null,
        pipeline: lookup('pipelines', relId(d, 'pipeline'))?.attributes?.name ?? null,
        stage: stage?.attributes?.name ?? null,
        sales_status: salesStatus,
        probability: a.probability ?? null,
        currency: a.currency ?? null,
        // raw API amounts, unconverted
        revenue: a.revenue ?? null,
        budget_total: a.budget_total ?? null,
        created_at: a.created_at ?? null,
        last_activity_at: a.last_activity_at ?? null,
        stage_updated_at: a.sales_status_updated_at ?? null,
        closed_at: a.sales_closed_at ?? null,
        changes,
      };
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          since: params.since,
          count: rows.length,
          truncated: rows.length >= MAX_API_PAGES * 200,
          deals: rows,
        }, null, 2),
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

// ---- Definitions ----

export const listDealsDefinition = {
  name: 'list_deals',
  description:
    'List sales deals across all projects that were created or updated on/after a date, newest activity first. ' +
    'Each deal has company, responsible person, pipeline, stage, sales status (open/won/lost/delivered), ' +
    'probability, raw amounts, and `changes` saying what happened since the date ' +
    '(most significant first: won, lost, created, stage_changed, or just updated). Use for "what happened in sales this week".',
  inputSchema: {
    type: 'object',
    properties: {
      since: {
        type: 'string',
        description: 'YYYY-MM-DD (required). Deals with activity on/after this date (or created, with created_only)',
      },
      created_only: {
        type: 'boolean',
        description: 'Only deals created on/after `since` (default false: created or updated)',
      },
      include_budgets: {
        type: 'boolean',
        description: 'Also return budgets, not just sales deals (default false)',
      },
      sales_status: {
        type: 'string',
        enum: ['open', 'won', 'lost', 'delivered'],
        description: 'Only deals with this sales status',
      },
      company_id: {
        type: 'string',
        description: 'Only deals of this company',
      },
      responsible_id: {
        type: 'string',
        description: 'Only deals this person is responsible for',
      },
    },
    required: ['since'],
  },
};
