import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { READ, result, type RegisterTools } from './context.js';
import { McpError, ErrorCode } from '../errors.js';
import type { ProductiveBooking, ProductiveIncludedResource } from '../api/types.js';

// ---- Schemas ----

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const listBookingsSchema = z.object({
  after: isoDate.describe('Range start, YYYY-MM-DD (inclusive)'),
  before: isoDate.describe('Range end, YYYY-MM-DD (inclusive)'),
  person_id: z.string().optional().describe('Only bookings of this person'),
  project_id: z.string().optional().describe('Only bookings on this project'),
  include_drafts: z.boolean().default(true).optional().describe('Include tentative (draft) bookings, flagged as tentative (default true)'),
  group_by: z.enum(['project', 'person', 'none']).default('project').optional()
    .describe('project (default): hours per project with people; person: hours per person with projects; none: one row per booking'),
});

// Percentage bookings are relative to capacity, which the booking doesn't carry.
const HOURS_PER_DAY = 8;
const MAX_API_PAGES = 10;

// ---- Helpers ----

function weekdaysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    const day = new Date(t);
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(day.toISOString().slice(0, 10));
  }
  return days;
}

/** Booked hours of `booking` that fall on weekdays inside [after, before]. */
function hoursInRange(booking: ProductiveBooking, after: string, before: string): number {
  const a = booking.attributes;
  const from = a.started_on > after ? a.started_on : after;
  const to = a.ended_on < before ? a.ended_on : before;
  const overlap = weekdaysBetween(from, to).length;
  if (!overlap) return 0;

  let minutesPerDay: number;
  if (a.booking_method_id === 2) {
    minutesPerDay = ((a.percentage ?? 0) / 100) * HOURS_PER_DAY * 60;
  } else if (a.booking_method_id === 3) {
    minutesPerDay = (a.total_time ?? 0) / Math.max(1, weekdaysBetween(a.started_on, a.ended_on).length);
  } else {
    minutesPerDay = a.time ?? 0;
  }
  return (minutesPerDay * overlap) / 60;
}

const round = (n: number) => Math.round(n * 10) / 10;

// ---- Handlers ----

export async function listBookingsTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listBookingsSchema.parse(args);
    const includeDrafts = params.include_drafts ?? true;
    const groupBy = params.group_by ?? 'project';

    const bookings: ProductiveBooking[] = [];
    const included = new Map<string, ProductiveIncludedResource>();
    for (let page = 1; page <= MAX_API_PAGES; page++) {
      const response = await client.listBookings({
        after: params.after,
        before: params.before,
        person_id: params.person_id,
        project_id: params.project_id,
        with_draft: includeDrafts,
        limit: 200,
        page,
      });
      bookings.push(...(response.data ?? []));
      for (const inc of response.included ?? []) included.set(`${inc.type}:${inc.id}`, inc);
      if (page >= (response.meta?.total_pages ?? 1)) break;
    }

    const lookup = (type: string, id?: string | null) => (id ? included.get(`${type}:${id}`) : undefined);
    const personName = (id?: string | null) => {
      const p = lookup('people', id);
      return p ? `${p.attributes.first_name ?? ''} ${p.attributes.last_name ?? ''}`.trim() : null;
    };

    const rows = bookings.map(b => {
      const personId = b.relationships?.person?.data?.id ?? null;
      const service = lookup('services', b.relationships?.service?.data?.id);
      const deal = lookup('deals', service?.relationships?.deal?.data?.id);
      const project = lookup('projects', deal?.relationships?.project?.data?.id);
      const event = lookup('events', b.relationships?.event?.data?.id);
      return {
        booking_id: b.id,
        kind: event ? 'absence' : 'work',
        person_id: personId,
        person: personName(personId),
        project_id: project?.id ?? null,
        project: project?.attributes?.name ?? null,
        service: service?.attributes?.name ?? null,
        event: event?.attributes?.name ?? null,
        started_on: b.attributes.started_on,
        ended_on: b.attributes.ended_on,
        hours_in_range: round(hoursInRange(b, params.after, params.before)),
        tentative: !!b.attributes.draft,
        note: b.attributes.note ?? null,
      };
    });

    const work = rows.filter(r => r.kind === 'work' && r.hours_in_range > 0);
    const absences = rows
      .filter(r => r.kind === 'absence')
      .map(({ person_id, person, event, started_on, ended_on, tentative }) => ({ person_id, person, event, started_on, ended_on, tentative }));

    let result: Record<string, unknown>;
    if (groupBy === 'none') {
      result = { bookings: work, absences };
    } else {
      const key = groupBy === 'project' ? 'project' : 'person';
      const other = groupBy === 'project' ? 'person' : 'project';
      const groups = new Map<string, { id: string | null; name: string | null; hours: number; tentative_only: boolean; breakdown: Map<string, number> }>();
      for (const r of work) {
        const id = r[`${key}_id`];
        const g = groups.get(String(id)) ?? { id, name: r[key], hours: 0, tentative_only: true, breakdown: new Map() };
        g.hours += r.hours_in_range;
        if (!r.tentative) g.tentative_only = false;
        const sub = r[other] ?? '(unassigned)';
        g.breakdown.set(sub, (g.breakdown.get(sub) ?? 0) + r.hours_in_range);
        groups.set(String(id), g);
      }
      const grouped = [...groups.values()]
        .sort((a, b) => b.hours - a.hours)
        .map(g => ({
          [`${key}_id`]: g.id,
          [key]: g.name,
          hours: round(g.hours),
          tentative_only: g.tentative_only,
          [groupBy === 'project' ? 'people' : 'projects']: [...g.breakdown.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([name, hours]) => ({ name, hours: round(hours) })),
        }));
      result = { [groupBy === 'project' ? 'projects' : 'people']: grouped, absences };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          range: { after: params.after, before: params.before },
          booking_count: bookings.length,
          truncated: bookings.length >= MAX_API_PAGES * 200,
          ...result,
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

// ---- Registration ----

export const registerBookingTools: RegisterTools = (server, { client }) => {
  server.registerTool(
    'list_bookings',
    {
      title: 'List bookings',
      description:
        'List resource-planning bookings (scheduled work and absences) overlapping a date range, by default as hours per project and person. ' +
        'Counts weekdays in the range only (public holidays not subtracted); percentage bookings assume an 8h day.',
      inputSchema: listBookingsSchema,
      annotations: READ,
    },
    (args) => result(listBookingsTool(client, args))
  );
};
