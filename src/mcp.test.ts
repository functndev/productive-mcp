// Drives the server through the real MCP SDK HTTP handler (stateless JSON-RPC over fetch), with
// the Productive API replaced by a recording router.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Config } from './config/index.js';
import { createMcpServer } from './mcp.js';

const config: Config = {
  PRODUCTIVE_API_TOKEN: 'token',
  PRODUCTIVE_ORG_ID: '1',
  PRODUCTIVE_USER_ID: '123',
  PRODUCTIVE_USER_EMAIL: 'me@functn.com',
  PRODUCTIVE_API_BASE_URL: 'https://api.productive.io/api/v2/',
};

type Call = { method: string; url: URL; body: any };
type Route = (call: Call) => unknown | Response;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Routes "METHOD path" (prefix match on the path after /api/v2/) and records every call. */
function mockProductive(routes: Record<string, Route>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = `${call.method} ${url.pathname.replace('/api/v2/', '')}`;
    const match = Object.keys(routes)
      .filter((route) => key.startsWith(route))
      .sort((a, b) => b.length - a.length)[0];
    if (!match) return Response.json({ errors: [{ detail: `unmocked ${key}` }] }, { status: 404 });
    const result = routes[match]!(call);
    return result instanceof Response ? result : Response.json(result);
  }) as typeof fetch;
  return calls;
}

let id = 0;
async function rpc(method: string, params: Record<string, unknown> = {}, protocolVersion = '2025-06-18') {
  const handler = createMcpHandler(() => createMcpServer(config));
  const modern = protocolVersion >= '2026-07-28';
  const res = await handler.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': protocolVersion,
        ...(modern && { 'mcp-method': method, ...(typeof params.name === 'string' && { 'mcp-name': params.name }) }),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method,
        params: modern
          ? {
              ...params,
              _meta: {
                'io.modelcontextprotocol/protocolVersion': protocolVersion,
                'io.modelcontextprotocol/clientCapabilities': {},
                'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
              },
            }
          : params,
      }),
    })
  );
  const text = await res.text();
  return JSON.parse(text.startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data:'))!.slice(5));
}

const callTool = async (name: string, args: Record<string, unknown>) => (await rpc('tools/call', { name, arguments: args })).result;
const textOf = (result: { content: Array<{ text: string }> }) => result.content.map((c) => c.text).join('\n');

const task = (attributes: Record<string, unknown> = {}) => ({
  data: { id: '1', type: 'tasks', attributes: { title: 'Fix login', description: '', updated_at: '2026-10-12', ...attributes } },
});

describe('tools/list', () => {
  test('advertises the merged tool set in a fixed order, with titles and annotations', async () => {
    const { tools } = (await rpc('tools/list')).result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual([
      'whoami',
      'list_users',
      'list_companies',
      'list_projects',
      'list_boards',
      'create_board',
      'list_task_lists',
      'get_task_list',
      'create_task_list',
      'copy_task_list',
      'update_task_list',
      'list_tasks',
      'get_task',
      'create_task',
      'update_task',
      'list_subtasks',
      'create_subtask',
      'list_todos',
      'get_todo',
      'create_todo',
      'update_todo',
      'list_comments',
      'get_comment',
      'add_task_comment',
      'update_comment',
      'add_comment_reaction',
      'list_task_dependencies',
      'get_task_dependency',
      'create_task_dependency',
      'list_workflow_statuses',
      'list_activities',
      'get_recent_updates',
      'list_time_entries',
      'create_time_entry',
      'list_project_deals',
      'list_services',
      'list_deals',
      'list_bookings',
      'list_folders',
      'get_folder',
      'create_folder',
      'update_folder',
      'list_pages',
      'get_page',
      'create_page',
      'update_page',
      'copy_page',
      'list_attachments',
      'get_attachment',
    ]);
    for (const tool of tools) {
      expect(tool.title).toBeString();
      expect(typeof tool.annotations.readOnlyHint).toBe('boolean');
      expect(tool.annotations.readOnlyHint).toBe(/^(list_|get_|whoami$)/.test(tool.name));
      expect(tool.inputSchema.$schema).toBeUndefined();
    }
  });

  test('carries 2026-07-28 cache hints for clients on the current revision', async () => {
    const { result } = await rpc('tools/list', {}, '2026-07-28');
    expect(result.resultType).toBe('complete');
    expect(result.ttlMs).toBe(60 * 60 * 1000);
    expect(result.cacheScope).toBe('private');
  });

  test('tells the model who "me" is', async () => {
    const { result } = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(result.instructions).toContain('person ID 123');
  });
});

describe('list_tasks', () => {
  test('resolves "me" and uses the larger default limit for a project', async () => {
    const calls = mockProductive({ 'GET tasks': () => ({ data: [] }) });
    await callTool('list_tasks', { assignee_id: 'me', project_id: '7' });
    expect(calls[0]!.url.searchParams.get('filter[assignee_id]')).toBe('123');
    expect(calls[0]!.url.searchParams.get('filter[project_id]')).toBe('7');
    expect(calls[0]!.url.searchParams.get('page[size]')).toBe('200');
  });
});

describe('list_task_lists', () => {
  test('filters by the folder alias for a board', async () => {
    const calls = mockProductive({ 'GET task_lists': () => ({ data: [] }) });
    const result = await callTool('list_task_lists', { board_id: '892791' });

    expect(result.isError).toBeUndefined();
    expect(calls[0]!.url.searchParams.get('filter[folder_id]')).toBe('892791');
    expect(calls[0]!.url.searchParams.get('filter[board_id]')).toBeNull();
  });
});

describe('update_task', () => {
  test('applies each requested change through its own implementation', async () => {
    const calls = mockProductive({ 'PATCH tasks/1': (call) => task(call.body.data.attributes) });
    const result = await callTool('update_task', { task_id: '1', title: 'Fix login on Safari', assignee_id: 'me' });

    expect(result.isError).toBeUndefined();
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches.map((c) => c.body.data.attributes?.title ?? c.body.data.relationships?.assignee?.data?.id)).toEqual([
      'Fix login on Safari',
      '123',
    ]);
    expect(textOf(result)).toContain('Title updated');
    expect(textOf(result)).toContain('Assigned to: Person ID 123');
  });

  test('reports what was already saved when a later change fails', async () => {
    let patches = 0;
    mockProductive({
      'PATCH tasks/1': () =>
        ++patches === 1 ? task({ title: 'Renamed' }) : Response.json({ errors: [{ detail: 'assignee not found' }] }, { status: 422 }),
    });
    const result = await callTool('update_task', { task_id: '1', title: 'Renamed', assignee_id: '999' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Title updated');
    expect(textOf(result)).toContain('Then the assignee change failed');
  });

  test('refuses a call that changes nothing', async () => {
    const calls = mockProductive({});
    const result = await callTool('update_task', { task_id: '1' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Nothing to update');
    expect(calls).toEqual([]);
  });
});

describe('logging', () => {
  let log: ReturnType<typeof spyOn>;
  beforeEach(() => {
    log = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  test('every tool call logs one tool_call line with its outcome', async () => {
    mockProductive({ 'GET tasks': () => ({ data: [] }) });
    await callTool('list_tasks', {});
    await callTool('update_task', { task_id: '1' });

    const lines: Array<Record<string, unknown>> = log.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
    expect(lines.map(({ event, tool, outcome, userEmail }) => ({ event, tool, outcome, userEmail }))).toEqual([
      { event: 'tool_call', tool: 'list_tasks', outcome: 'ok', userEmail: 'me@functn.com' },
      { event: 'tool_call', tool: 'update_task', outcome: 'error', userEmail: 'me@functn.com' },
    ]);
  });
});
