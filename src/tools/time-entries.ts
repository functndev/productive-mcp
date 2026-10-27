import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '../errors.js';
import { ProductiveTimeEntryCreate } from '../api/types.js';
import { READ, WRITE, result, type RegisterTools } from './context.js';

// Helper function to parse time input into minutes
function parseTimeToMinutes(timeInput: string): number {
  const input = timeInput.toLowerCase().trim();
  
  // Handle hour formats: "2h", "2.5h", "2 hours"
  const hourMatch = input.match(/^(\d*\.?\d+)\s*h(?:ours?)?$/);
  if (hourMatch) {
    return Math.round(parseFloat(hourMatch[1]) * 60);
  }
  
  // Handle minute formats: "120m", "120 minutes"
  const minuteMatch = input.match(/^(\d+)\s*m(?:inutes?)?$/);
  if (minuteMatch) {
    return parseInt(minuteMatch[1], 10);
  }
  
  // Handle decimal hour formats: "2.5", "1.25"
  const decimalMatch = input.match(/^(\d*\.?\d+)$/);
  if (decimalMatch) {
    return Math.round(parseFloat(decimalMatch[1]) * 60);
  }
  
  throw new Error(`Invalid time format: ${timeInput}. Use formats like "2h", "120m", or "2.5"`);
}

// Helper function to parse date input
function parseDate(dateInput: string): string {
  const input = dateInput.toLowerCase().trim();
  const today = new Date();
  
  if (input === 'today') {
    return today.toISOString().split('T')[0];
  }
  
  if (input === 'yesterday') {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.toISOString().split('T')[0];
  }
  
  // Validate YYYY-MM-DD format
  const dateMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const month = parseInt(dateMatch[2], 10);
    const day = parseInt(dateMatch[3], 10);
    
    // Basic validation
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error(`Invalid date: ${dateInput}`);
    }
    
    return input;
  }
  
  throw new Error(`Invalid date format: ${dateInput}. Use "today", "yesterday", or YYYY-MM-DD format`);
}

export const listTimeEntriesSchema = z.object({
  date: z.string().optional().describe('Only this date, YYYY-MM-DD'),
  after: z.string().optional().describe('Only entries after this date, YYYY-MM-DD'),
  before: z.string().optional().describe('Only entries before this date, YYYY-MM-DD'),
  person_id: z.string().optional().describe('Only entries of this person; "me" for you'),
  project_id: z.string().optional().describe('Only entries on this project'),
  task_id: z.string().optional().describe('Only entries on this task'),
  service_id: z.string().optional().describe('Only entries on this service'),
  limit: z.number().min(1).max(200).default(30).optional().describe('Entries to return (1-200, default 30)'),
});

export const createTimeEntrySchema = z.object({
  date: z.string().min(1, 'Date is required').describe('"today", "yesterday" or YYYY-MM-DD'),
  time: z.string().min(1, 'Time is required').describe('Duration like "2h", "120m", "2.5h" or "2.5" (hours)'),
  person_id: z.string().min(1, 'Person ID is required').describe('Person logging the time; "me" for you'),
  service_id: z.string().min(1, 'Service ID is required').describe('Service the time is booked on (from list_services with deal_id)'),
  task_id: z.string().optional().describe('Task worked on (recommended; find it with list_tasks and project_id)'),
  note: z.string().min(10, 'Work description must be at least 10 characters')
    .describe('What was done, specifically (bullet points for several items; at least 10 characters)'),
  billable_time: z.string().optional().describe('Billable duration, same format as time; defaults to time'),
  confirm: z.boolean().optional().default(false).describe('true creates the entry; call without it first to preview'),
});

export const listServicesSchema = z.object({
  deal_id: z.string().optional().describe('Only services of this deal/budget (from list_project_deals); use this to find the service_id for create_time_entry'),
  company_id: z.string().optional().describe('Only services of this company'),
  limit: z.number().min(1).max(200).default(30).optional().describe('Services to return (1-200, default 30)'),
});

export async function listTimeEntresTool(
  client: ProductiveAPIClient,
  args: unknown,
  config?: { PRODUCTIVE_USER_ID?: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listTimeEntriesSchema.parse(args);
    
    // Handle "me" reference for person_id
    let personId = params.person_id;
    if (personId === 'me') {
      if (!config?.PRODUCTIVE_USER_ID) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Cannot use "me" reference - PRODUCTIVE_USER_ID is not configured in environment'
        );
      }
      personId = config.PRODUCTIVE_USER_ID;
    }
    
    const response = await client.listTimeEntries({
      date: params.date,
      after: params.after,
      before: params.before,
      person_id: personId,
      project_id: params.project_id,
      task_id: params.task_id,
      service_id: params.service_id,
      limit: params.limit,
    });
    
    if (!response.data || response.data.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No time entries found matching the criteria.',
        }],
      };
    }
    
    const entriesText = response.data.map(entry => {
      const personId = entry.relationships?.person?.data?.id;
      const serviceId = entry.relationships?.service?.data?.id;
      const taskId = entry.relationships?.task?.data?.id;
      const projectId = entry.relationships?.project?.data?.id;
      
      const hours = Math.floor(entry.attributes.time / 60);
      const minutes = entry.attributes.time % 60;
      const timeDisplay = hours > 0 
        ? (minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`)
        : `${minutes}m`;
      
      let billableDisplay = '';
      if (entry.attributes.billable_time !== undefined && entry.attributes.billable_time !== entry.attributes.time) {
        const billableHours = Math.floor(entry.attributes.billable_time / 60);
        const billableMinutes = entry.attributes.billable_time % 60;
        const billableTimeDisplay = billableHours > 0 
          ? (billableMinutes > 0 ? `${billableHours}h ${billableMinutes}m` : `${billableHours}h`)
          : `${billableMinutes}m`;
        billableDisplay = ` (Billable: ${billableTimeDisplay})`;
      }
      
      return `• Time Entry (ID: ${entry.id})
  Date: ${entry.attributes.date}
  Time: ${timeDisplay}${billableDisplay}
  Note: ${entry.attributes.note || 'No note'}
  Person ID: ${personId || 'Unknown'}
  Service ID: ${serviceId || 'Unknown'}
  Task ID: ${taskId || 'None'}
  Project ID: ${projectId || 'None'}`;
    }).join('\n\n');
    
    const totalMinutes = response.data.reduce((sum, entry) => sum + entry.attributes.time, 0);
    const totalHours = Math.floor(totalMinutes / 60);
    const totalMins = totalMinutes % 60;
    const totalDisplay = totalHours > 0 
      ? (totalMins > 0 ? `${totalHours}h ${totalMins}m` : `${totalHours}h`)
      : `${totalMins}m`;
    
    const summary = `Found ${response.data.length} time entr${response.data.length !== 1 ? 'ies' : 'y'}${response.meta?.total_count ? ` (showing ${response.data.length} of ${response.meta.total_count})` : ''}:\n\nTotal Time: ${totalDisplay}\n\n${entriesText}`;
    
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

export async function createTimeEntryTool(
  client: ProductiveAPIClient,
  args: unknown,
  config?: { PRODUCTIVE_USER_ID?: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = createTimeEntrySchema.parse(args);
    
    // Handle "me" reference for person_id
    let personId = params.person_id;
    if (personId === 'me') {
      if (!config?.PRODUCTIVE_USER_ID) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Cannot use "me" reference - PRODUCTIVE_USER_ID is not configured in environment'
        );
      }
      personId = config.PRODUCTIVE_USER_ID;
    }
    
    // Parse and validate date
    let parsedDate: string;
    try {
      parsedDate = parseDate(params.date);
    } catch (error) {
      throw new McpError(
        ErrorCode.InvalidParams,
        error instanceof Error ? error.message : 'Invalid date format'
      );
    }
    
    // Parse and validate time
    let timeInMinutes: number;
    try {
      timeInMinutes = parseTimeToMinutes(params.time);
    } catch (error) {
      throw new McpError(
        ErrorCode.InvalidParams,
        error instanceof Error ? error.message : 'Invalid time format'
      );
    }
    
    // Parse billable time if provided
    let billableTimeInMinutes: number | undefined;
    if (params.billable_time) {
      try {
        billableTimeInMinutes = parseTimeToMinutes(params.billable_time);
      } catch (error) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid billable time format: ${error instanceof Error ? error.message : 'Invalid time format'}`
        );
      }
    }
    
    // If not confirmed, show confirmation details
    if (!params.confirm) {
      const hours = Math.floor(timeInMinutes / 60);
      const minutes = timeInMinutes % 60;
      const timeDisplay = hours > 0 
        ? (minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`)
        : `${minutes}m`;
      
      let billableDisplay = '';
      if (billableTimeInMinutes !== undefined) {
        const billableHours = Math.floor(billableTimeInMinutes / 60);
        const billableMins = billableTimeInMinutes % 60;
        const billableTimeDisplay = billableHours > 0 
          ? (billableMins > 0 ? `${billableHours}h ${billableMins}m` : `${billableHours}h`)
          : `${billableMins}m`;
        billableDisplay = `\nBillable Time: ${billableTimeDisplay}`;
      }
      
      return {
        content: [{
          type: 'text',
          text: `Time Entry Ready to Create:

Date: ${parsedDate}
Time: ${timeDisplay}${billableDisplay}
Person ID: ${personId}${params.person_id === 'me' ? ' (me)' : ''}
Service ID: ${params.service_id}
${params.task_id ? `Task ID: ${params.task_id}` : 'No task specified'}
${params.note ? `Note: ${params.note}` : 'No note'}

To create this time entry, call this tool again with the same parameters and add "confirm": true`,
        }],
      };
    }
    
    const timeEntryData: ProductiveTimeEntryCreate = {
      data: {
        type: 'time_entries',
        attributes: {
          date: parsedDate,
          time: timeInMinutes,
          ...(billableTimeInMinutes !== undefined && { billable_time: billableTimeInMinutes }),
          ...(params.note && { note: params.note }),
        },
        relationships: {
          person: {
            data: {
              id: personId,
              type: 'people',
            },
          },
          service: {
            data: {
              id: params.service_id,
              type: 'services',
            },
          },
        },
      },
    };
    
    // Add task relationship if provided
    if (params.task_id) {
      timeEntryData.data.relationships.task = {
        data: {
          id: params.task_id,
          type: 'tasks',
        },
      };
    }
    
    const response = await client.createTimeEntry(timeEntryData);
    
    const hours = Math.floor(response.data.attributes.time / 60);
    const minutes = response.data.attributes.time % 60;
    const timeDisplay = hours > 0 
      ? (minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`)
      : `${minutes}m`;
    
    let billableDisplay = '';
    if (response.data.attributes.billable_time !== undefined && response.data.attributes.billable_time !== response.data.attributes.time) {
      const billableHours = Math.floor(response.data.attributes.billable_time / 60);
      const billableMins = response.data.attributes.billable_time % 60;
      const billableTimeDisplay = billableHours > 0 
        ? (billableMins > 0 ? `${billableHours}h ${billableMins}m` : `${billableHours}h`)
        : `${billableMins}m`;
      billableDisplay = `\nBillable Time: ${billableTimeDisplay}`;
    }
    
    let text = `Time entry created successfully!
Date: ${response.data.attributes.date}
Time: ${timeDisplay}${billableDisplay}
ID: ${response.data.id}`;
    
    if (response.data.attributes.note) {
      text += `\nNote: ${response.data.attributes.note}`;
    }
    
    text += `\nPerson ID: ${personId}`;
    if (params.person_id === 'me' && config?.PRODUCTIVE_USER_ID) {
      text += ` (me)`;
    }
    
    text += `\nService ID: ${params.service_id}`;
    
    if (params.task_id) {
      text += `\nTask ID: ${params.task_id}`;
    }
    
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

/** Lists services, optionally only those of one deal/budget (the timesheet flow) or one company. */
export async function listServicesTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listServicesSchema.parse(args);

    if (params.deal_id && params.company_id) {
      throw new McpError(ErrorCode.InvalidParams, 'Pass either deal_id or company_id, not both');
    }

    const response = params.deal_id
      ? await client.listDealServices({ deal_id: params.deal_id, limit: params.limit })
      : await client.listServices({ company_id: params.company_id, limit: params.limit });

    if (!response.data || response.data.length === 0) {
      return {
        content: [{
          type: 'text',
          text: params.deal_id ? 'No services found for this deal/budget.' : 'No services found matching the criteria.',
        }],
      };
    }

    const servicesText = response.data.map(service => {
      const companyId = service.relationships?.company?.data?.id;
      return `• ${service.attributes.name || 'Unnamed Service'} (ID: ${service.id})
  ${companyId ? `Company ID: ${companyId}` : ''}
  ${service.attributes.description ? `Description: ${service.attributes.description}` : 'No description'}`;
    }).join('\n\n');

    const count = `${response.data.length} service${response.data.length !== 1 ? 's' : ''}`;
    const shown = response.meta?.total_count ? ` (showing ${response.data.length} of ${response.meta.total_count})` : '';
    const summary = params.deal_id
      ? `Found ${count} for deal/budget ${params.deal_id}${shown}:\n\n${servicesText}`
      : `Found ${count}${shown}:\n\n${servicesText}`;

    return {
      content: [{
        type: 'text',
        text: summary,
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

// Zod schema for list project deals/budgets
export const listProjectDealsSchema = z.object({
  project_id: z.string().min(1, 'Project ID is required').describe('The project ID'),
  type: z.number().int().min(1).max(2).optional().describe('Only 1 = deals or 2 = budgets'),
  limit: z.number().min(1).max(200).default(30).optional().describe('Deals/budgets to return (1-200, default 30)'),
});

// Tool function for list project deals/budgets
export async function listProjectDealsTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listProjectDealsSchema.parse(args);
    
    const response = await client.listProjectDeals({
      project_id: params.project_id,
      type: params.type,
      limit: params.limit,
    });
    
    if (!response.data || response.data.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No deals/budgets found for this project.',
        }],
      };
    }
    
    const dealsText = response.data.map(deal => {
      const budgetType = deal.attributes.budget ? 'Budget' : 'Deal';
      const value = deal.attributes.value ? ` (Value: ${deal.attributes.value})` : '';
      
      return `• ${budgetType} (ID: ${deal.id})
  Name: ${deal.attributes.name}${value}`;
    }).join('\n\n');
    
    const typeFilter = params.type === 1 ? ' deals' : 
                      params.type === 2 ? ' budgets' : ' deals/budgets';
    
    const summary = `Found ${response.data.length}${typeFilter} for project ${params.project_id}:\n\n${dealsText}`;
    
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

export const registerTimeTools: RegisterTools = (server, { client, config }) => {
  server.registerTool(
    'list_time_entries',
    {
      title: 'List time entries',
      description: 'List logged time entries with date, duration, note, person, service, task and project, plus the total.',
      inputSchema: listTimeEntriesSchema,
      annotations: READ,
    },
    (args) => result(listTimeEntresTool(client, args, config))
  );
  server.registerTool(
    'create_time_entry',
    {
      title: 'Create time entry',
      description:
        'Log time on a service. Find service_id via list_projects → list_project_deals → list_services with deal_id; optionally link a task (list_tasks with project_id). ' +
        'Call without confirm first to preview, then again with confirm: true.',
      inputSchema: createTimeEntrySchema,
      annotations: WRITE,
    },
    (args) => result(createTimeEntryTool(client, args, config))
  );
  server.registerTool(
    'list_project_deals',
    {
      title: 'List project deals',
      description: 'List the deals/budgets of a project. For logging time: list_projects → list_project_deals → list_services with deal_id → create_time_entry.',
      inputSchema: listProjectDealsSchema,
      annotations: READ,
    },
    (args) => result(listProjectDealsTool(client, args))
  );
  server.registerTool(
    'list_services',
    {
      title: 'List services',
      description:
        'List services, the budget lines time is logged on. Pass deal_id (from list_project_deals) to get the services a time entry can use; ' +
        'without it, all services of the organisation are listed, with no link to a project.',
      inputSchema: listServicesSchema,
      annotations: READ,
    },
    (args) => result(listServicesTool(client, args))
  );
};
