// Drives the server through the real MCP SDK HTTP handler (stateless JSON-RPC over fetch), with
// the Productive API replaced by a recording router.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Config } from './config/index.js';
import { checkLine } from './lib/log.js';
import { createMcpServer, type McpUser } from './mcp.js';
import { refusalOf } from './api/transport.js';
import type { ProviderError } from './apps-functn-com/connections-client.js';

/** Productive straight through the (mocked) global fetch; in the Worker it is apps.functn.com Connections. */
const direct = (url: string, init?: RequestInit) => fetch(url, init);

const config: Config = {
  PRODUCTIVE_USER_ID: '123',
  PRODUCTIVE_USER_EMAIL: 'me@functn.com',
  PRODUCTIVE_API_BASE_URL: 'https://api.productive.io/api/v2/',
  transport: direct,
  systemTransport: direct,
};
const EDITOR: McpUser = { email: 'me@functn.com', role: 'editor' };
let user: McpUser = EDITOR;
let serverConfig: Config = config;
beforeEach(() => {
  user = EDITOR;
  serverConfig = config;
});

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
  const handler = createMcpHandler(() => createMcpServer(serverConfig, user));
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
    // Depends on the person's role, so no longer than the access token lives.
    expect(result.ttlMs).toBe(10 * 60 * 1000);
    expect(result.cacheScope).toBe('private');
  });

  test('names the server by the convention and tells the model where to start', async () => {
    const { result } = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(result.serverInfo).toMatchObject({ name: 'functn-productive', title: 'functn Productive' });
    expect(result.instructions).toContain('whoami');
  });

  test('a reader sees only the tools that read', async () => {
    user = { email: 'me@functn.com', role: 'reader' };
    const { tools } = (await rpc('tools/list')).result;
    expect(tools.length).toBe(29);
    for (const tool of tools) expect(tool.annotations.readOnlyHint).toBe(true);
  });

  test("a reader's call to a write tool is refused, and Productive is never called", async () => {
    user = { email: 'me@functn.com', role: 'reader' };
    const calls = mockProductive({ 'POST tasks': () => ({ data: { id: '1', type: 'tasks', attributes: {} } }) });
    const response = await rpc('tools/call', { name: 'create_task', arguments: { title: 'x', project_id: '1', task_list_id: '2' } });
    expect(JSON.stringify(response)).toContain('create_task');
    expect(response.result?.isError ?? Boolean(response.error)).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('roles', () => {
  test('every tool declares its minimum role, and write tools need editor', async () => {
    const { TOOL_ROLES } = await import('./roles.js');
    const { tools } = (await rpc('tools/list')).result;
    expect(Object.keys(TOOL_ROLES).sort()).toEqual(tools.map((t: { name: string }) => t.name).sort());
    for (const tool of tools) expect(TOOL_ROLES[tool.name]).toBe(tool.annotations.readOnlyHint ? 'reader' : 'editor');
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

// Productive retired /boards and filter[board_id]; folders took their place. These pin the keys
// the live API accepts, so a regression to the board names fails here rather than in production.
describe('folders instead of boards', () => {
  test('list_task_lists filters by folder_id and shows the folder relationship', async () => {
    const calls = mockProductive({
      'GET task_lists': () => ({
        data: [{ id: '5', type: 'task_lists', attributes: { name: 'Sprint' }, relationships: { folder: { data: { id: '882467', type: 'folders' } } } }],
      }),
    });
    const result = await callTool('list_task_lists', { folder_id: '882467' });

    expect(result.isError).toBeUndefined();
    expect(calls[0]!.url.searchParams.get('filter[folder_id]')).toBe('882467');
    expect(calls[0]!.url.searchParams.has('filter[board_id]')).toBe(false);
    expect(textOf(result)).toContain('Folder ID: 882467');
  });

  test('create_task_list sends folder_id as an attribute, not a board relationship', async () => {
    const calls = mockProductive({ 'POST task_lists': (call) => ({ data: { id: '5', type: 'task_lists', attributes: call.body.data.attributes } }) });
    const result = await callTool('create_task_list', { folder_id: '882467', project_id: '7', name: 'Sprint' });

    expect(result.isError).toBeUndefined();
    expect(calls[0]!.body.data.attributes).toMatchObject({ folder_id: '882467', project_id: '7', name: 'Sprint' });
    expect(calls[0]!.body.data.relationships).toBeUndefined();
  });

  test('copy_task_list and moving a task list send folder_id', async () => {
    const calls = mockProductive({
      'POST task_lists/copy': () => ({ data: { id: '6', type: 'task_lists', attributes: { name: 'Copy' } } }),
      'PATCH task_lists/5/move': () => new Response(null, { status: 204 }),
    });
    await callTool('copy_task_list', { name: 'Copy', template_id: '5', project_id: '7', folder_id: '882467' });
    await callTool('update_task_list', { task_list_id: '5', folder_id: '882468' });

    expect(calls[0]!.body.data.attributes.folder_id).toBe('882467');
    expect(calls[0]!.body.data.attributes.board_id).toBeUndefined();
    expect(calls[1]!.body.data.attributes).toEqual({ folder_id: '882468' });
  });

  test('to_backlog finds the Backlog list through the project folders', async () => {
    const calls = mockProductive({
      'GET tasks/1': () => ({ data: { id: '1', type: 'tasks', attributes: {}, relationships: { project: { data: { id: '7', type: 'projects' } } } } }),
      'GET folders': () => ({ data: [{ id: '882467', type: 'folders', attributes: { name: 'Main' } }] }),
      'GET task_lists': () => ({ data: [{ id: '9', type: 'task_lists', attributes: { name: 'Backlog' } }] }),
      'PATCH tasks/1': () => task(),
    });
    const result = await callTool('update_task', { task_id: '1', to_backlog: true });

    expect(result.isError).toBeUndefined();
    expect(calls.map((c) => `${c.method} ${c.url.pathname.replace('/api/v2/', '')}`)).toEqual(['GET tasks/1', 'GET folders', 'GET task_lists', 'PATCH tasks/1']);
    expect(calls[1]!.url.searchParams.get('filter[project_id]')).toBe('7');
    expect(calls[2]!.url.searchParams.get('filter[folder_id]')).toBe('882467');
    expect(calls[3]!.body.data.relationships.task_list.data.id).toBe('9');
  });

  test('to_backlog creates a missing Backlog list in the first folder', async () => {
    const calls = mockProductive({
      'GET tasks/1': () => ({ data: { id: '1', type: 'tasks', attributes: {}, relationships: { project: { data: { id: '7', type: 'projects' } } } } }),
      'GET folders': () => ({ data: [{ id: '882467', type: 'folders', attributes: { name: 'Main' } }] }),
      'GET task_lists': () => ({ data: [] }),
      'POST task_lists': () => ({ data: { id: '10', type: 'task_lists', attributes: { name: 'Backlog' } } }),
      'PATCH tasks/1': () => task(),
    });
    await callTool('update_task', { task_id: '1', to_backlog: true });

    const create = calls.find((c) => c.method === 'POST')!;
    expect(create.body.data.attributes).toMatchObject({ name: 'Backlog', project_id: '7', folder_id: '882467' });
    expect(create.body.data.relationships).toBeUndefined();
  });

  test('create_task does not accept or send a board', async () => {
    const calls = mockProductive({ 'POST tasks': () => task() });
    await callTool('create_task', { title: 'Fix login', task_list_id: '5', board_id: '882467' });

    expect(calls[0]!.body.data.relationships.board).toBeUndefined();
    expect(calls[0]!.body.data.relationships.task_list.data.id).toBe('5');
  });
});

describe('task description HTML', () => {
  // Productive escapes <s> and <strike> into literal text and keeps only <del>.
  const html = '<p><s>done</s>, <STRIKE class="x">gone</STRIKE>, <span>kept</span>, <strong>kept</strong></p>';
  const expected = '<p><del>done</del>, <del class="x">gone</del>, <span>kept</span>, <strong>kept</strong></p>';

  test('create_task sends strikethrough as <del>', async () => {
    const calls = mockProductive({ 'POST tasks': () => task() });
    await callTool('create_task', { title: 'Fix login', task_list_id: '5', description_html: html });
    expect(calls[0]!.body.data.attributes.description).toBe(expected);
  });

  test('update_task sends strikethrough as <del>', async () => {
    const calls = mockProductive({ 'PATCH tasks/1': (call) => task(call.body.data.attributes) });
    await callTool('update_task', { task_id: '1', description_html: html });
    expect(calls[0]!.body.data.attributes.description).toBe(expected);
  });

  test('a plain-text description is sent unchanged', async () => {
    const calls = mockProductive({ 'POST tasks': () => task() });
    await callTool('create_task', { title: 'Fix login', task_list_id: '5', description: 'use <s> tags' });
    expect(calls[0]!.body.data.attributes.description).toBe('use <s> tags');
  });
});

describe('list_project_deals', () => {
  test('filters deals vs. budgets with filter[type] and labels them from the budget flag', async () => {
    const calls = mockProductive({
      'GET deals': () => ({ data: [{ id: '3', type: 'deals', attributes: { name: 'Retainer', budget: true } }] }),
    });
    const result = await callTool('list_project_deals', { project_id: '7', type: 2 });

    expect(calls[0]!.url.searchParams.get('filter[type]')).toBe('2');
    expect(calls[0]!.url.searchParams.has('filter[budget_type]')).toBe(false);
    expect(textOf(result)).toContain('Budget (ID: 3)');
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
  type Line = Record<string, unknown> & { level: string };
  let spies: Array<ReturnType<typeof spyOn>>;
  beforeEach(() => {
    spies = (['info', 'warn', 'error'] as const).map((level) => spyOn(console, level).mockImplementation(() => {}));
  });
  afterEach(() => {
    // Every line any test here wrote follows the logging convention.
    const problems = spies.flatMap((spy, i) =>
      spy.mock.calls.flatMap((call: unknown[]) => checkLine(String(call[0]), (['info', 'warn', 'error'] as const)[i]))
    );
    spies.forEach((spy) => spy.mockRestore());
    expect(problems).toEqual([]);
  });
  /** Every line written so far, in order, with the console method as `level`. */
  const lines = (): Line[] =>
    spies
      .flatMap((spy, i) =>
        spy.mock.calls.map((call: unknown[], n: number) => ({
          order: spy.mock.invocationCallOrder[n]!,
          line: { level: ['info', 'warn', 'error'][i]!, ...JSON.parse(String(call[0])) } as Line,
        }))
      )
      .sort((x, y) => x.order - y.order)
      .map(({ line }) => line);

  test('a tool call is one mcp.tool line with the actor, its ids and its Productive calls', async () => {
    mockProductive({ 'GET tasks': () => ({ data: [] }) });
    await callTool('list_tasks', { project_id: '7' });
    expect(lines()).toEqual([
      expect.objectContaining({
        level: 'info',
        event: 'mcp.tool',
        tool: 'list_tasks',
        actor: 'me@functn.com',
        role: 'editor',
        productivePersonId: '123',
        projectId: '7',
        productiveCalls: 1,
        result: 'ok',
      }),
    ]);
  });

  test('logs what a write changed, never the content it wrote', async () => {
    mockProductive({ 'PATCH tasks/1': () => task({ title: 'Secret plan' }) });
    await callTool('update_task', { task_id: '1', title: 'Secret plan' });
    const [line] = lines();
    expect(line).toMatchObject({ event: 'mcp.tool', taskId: '1', writes: ['PATCH tasks/1'], result: 'ok' });
    expect(JSON.stringify(line)).not.toContain('Secret plan');
  });

  test('bad input is a tool error, not a failure', async () => {
    mockProductive({});
    await callTool('update_task', { task_id: '1' });
    expect(lines()).toEqual([
      expect.objectContaining({ level: 'info', event: 'mcp.tool', toolError: 'invalid_input', result: 'ok' }),
    ]);
  });

  test('arguments the schema rejects: invalid_input with the issues, never the values', async () => {
    const calls = mockProductive({});
    const result = await callTool('list_tasks', { project_id: '7', limit: 'secret-looking value' });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(lines()).toEqual([
      expect.objectContaining({
        level: 'info',
        event: 'mcp.tool',
        tool: 'list_tasks',
        actor: 'me@functn.com',
        result: 'ok',
        toolError: 'invalid_input',
        issues: [expect.objectContaining({ path: 'limit', code: 'invalid_type', expected: 'number' })],
      }),
    ]);
    expect(JSON.stringify(lines())).not.toContain('secret-looking value');
  });

  test('a setup someone at functn must fix is not_configured, and fails at error (D6)', async () => {
    mockProductive({});
    serverConfig = { ...config, systemTransport: undefined };
    await callTool('list_users', {});
    expect(lines()).toEqual([
      expect.objectContaining({ level: 'error', event: 'mcp.tool', toolError: 'not_configured', result: 'failed' }),
    ]);
  });

  test('a Productive 4xx is a warn line and a tool error of the kind its status means', async () => {
    mockProductive({ 'GET tasks/9': () => Response.json({ errors: [{ detail: 'The requested record was not found' }] }, { status: 404 }) });
    const result = await callTool('get_task', { task_id: '9' });
    expect(result.isError).toBe(true);
    expect(lines()).toEqual([
      expect.objectContaining({ level: 'warn', event: 'productive.request_failed', httpMethod: 'GET', path: 'tasks/9', productiveStatus: 404 }),
      expect.objectContaining({
        level: 'info',
        event: 'mcp.tool',
        toolError: 'not_found',
        productiveCalls: 1,
        productiveFailed: 1,
        productiveStatus: 404,
        result: 'ok',
      }),
    ]);
  });

  test.each([
    [400, 'invalid_input'],
    [403, 'forbidden'],
    [409, 'conflict'],
    [410, 'not_found'],
    [422, 'invalid_input'],
  ])('a Productive %i is %s', async (status, kind) => {
    mockProductive({ 'GET tasks': () => Response.json({ errors: [{ detail: 'Nope' }] }, { status }) });
    await callTool('list_tasks', {});
    expect(lines().slice(-1)[0]).toMatchObject({ level: 'info', event: 'mcp.tool', toolError: kind, toolMessage: 'Nope', result: 'ok' });
  });

  test('a Productive 429 is rate_limited, says when to retry, and the call fails at error', async () => {
    mockProductive({ 'GET tasks': () => new Response('busy', { status: 429, headers: { 'retry-after': '10' } }) });
    const result = await callTool('list_tasks', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Try again in 10 seconds');
    expect(lines()).toEqual([
      expect.objectContaining({ level: 'warn', event: 'productive.rate_limited', productiveStatus: 429, retryAfter: '10' }),
      expect.objectContaining({
        level: 'error',
        event: 'mcp.tool',
        tool: 'list_tasks',
        toolError: 'rate_limited',
        productiveStatus: 429,
        productiveFailed: 1,
        result: 'failed',
      }),
    ]);
  });

  test("a Productive 401 is the person's own token: forbidden, theirs to replace on apps.functn.com", async () => {
    mockProductive({ 'GET tasks': () => Response.json({ errors: [{ detail: 'Unauthorized' }] }, { status: 401 }) });
    const result = await callTool('list_tasks', {});
    expect(textOf(result)).toContain('https://apps.functn.com');
    expect(lines().slice(-1)[0]).toMatchObject({
      level: 'info',
      event: 'mcp.tool',
      toolError: 'forbidden',
      productiveStatus: 401,
      result: 'ok',
    });
  });

  /** Productive through a stand-in for Connections that refuses with `error`. */
  const connectionsRefuses = (error: ProviderError) => {
    serverConfig = { ...config, transport: async () => Promise.reject(refusalOf(error)) };
  };

  test('no Productive account connected: a forbidden tool error that says where to connect', async () => {
    connectionsRefuses({ ok: false, error: 'not_connected', message: 'Productive is not connected.', connectUrl: 'https://apps.functn.com/?provider=productive' });
    const result = await callTool('list_tasks', {});
    expect(textOf(result)).toContain('https://apps.functn.com/?provider=productive');
    expect(lines()).toEqual([
      expect.objectContaining({ level: 'warn', event: 'productive.request_failed', connectionsError: 'not_connected' }),
      expect.objectContaining({ level: 'info', event: 'mcp.tool', toolError: 'forbidden', result: 'ok' }),
    ]);
  });

  test('apps.functn.com refusing this server is ours: not_configured, failed at error (D6)', async () => {
    connectionsRefuses({ ok: false, error: 'not_allowed', message: 'productive-mcp may not GET tasks' });
    const result = await callTool('list_tasks', {});
    expect(textOf(result)).toContain('Tell functn IT');
    expect(textOf(result)).not.toContain('may not GET');
    expect(lines().slice(-1)[0]).toMatchObject({ level: 'error', event: 'mcp.tool', toolError: 'not_configured', result: 'failed' });
  });

  test('apps.functn.com down is upstream, failed at error (D13)', async () => {
    connectionsRefuses({ ok: false, error: 'unavailable', message: 'apps.functn.com is not working right now' });
    await callTool('list_tasks', {});
    expect(lines().slice(-1)[0]).toMatchObject({ level: 'error', event: 'mcp.tool', toolError: 'upstream', result: 'failed' });
  });

  test('list_users runs as the Productive bot, not as the person', async () => {
    const used: string[] = [];
    serverConfig = {
      ...config,
      transport: async (url, init) => (used.push(`person ${url}`), fetch(url, init)),
      systemTransport: async (url, init) => (used.push(`bot ${url}`), fetch(url, init)),
    };
    mockProductive({ 'GET people': () => ({ data: [] }) });
    await callTool('list_users', {});
    expect(used.map((u) => u.split(' ')[0])).toEqual(['bot']);
  });

  test("Productive's own trouble fails the call at error and tells the model it is upstream (D13)", async () => {
    mockProductive({ 'GET tasks': () => new Response('down', { status: 502 }) });
    const result = await callTool('list_tasks', {});
    expect(textOf(result)).toContain('Productive is having trouble (status 502)');
    expect(lines().slice(-1)[0]).toMatchObject({
      level: 'error',
      event: 'mcp.tool',
      toolError: 'upstream',
      productiveStatus: 502,
      result: 'failed',
    });
  });

  test('a status no kind fits fails the call at error without a kind', async () => {
    mockProductive({ 'GET tasks': () => new Response('nope', { status: 405 }) });
    await callTool('list_tasks', {});
    const line = lines().slice(-1)[0]!;
    expect(line).toMatchObject({ level: 'error', event: 'mcp.tool', productiveStatus: 405, result: 'failed' });
    expect(line).not.toHaveProperty('toolError');
  });

  test('a Productive call that times out is upstream and says so', async () => {
    globalThis.fetch = (async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof fetch;
    const result = await callTool('list_tasks', {});
    expect(textOf(result)).toContain('did not answer within 15 seconds');
    expect(lines()).toEqual([
      expect.objectContaining({ level: 'warn', event: 'productive.request_failed', timedOut: true }),
      expect.objectContaining({ level: 'error', event: 'mcp.tool', toolError: 'upstream', productiveStatus: 0, result: 'failed' }),
    ]);
  });

  test("the file host's login page is a forbidden tool error, not a failure", async () => {
    mockProductive({
      'GET attachments/5': () => ({
        data: { id: '5', type: 'attachments', attributes: { name: 'a.pdf', content_type: 'application/pdf', size: 10, url: 'https://files.productive.io/a.pdf' } },
      }),
      'GET /a.pdf': () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    });
    await callTool('get_attachment', { attachment_id: '5', raw: true });
    expect(lines().slice(-1)[0]).toMatchObject({ level: 'info', event: 'mcp.tool', toolError: 'forbidden', result: 'ok' });
  });

  test('every Productive call carries a timeout signal', async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return Response.json({ data: [] });
    }) as typeof fetch;
    await callTool('list_tasks', {});
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test('a failed merged update logs the cause, not the saved changes its message lists', async () => {
    let patches = 0;
    mockProductive({
      'PATCH tasks/1': () => (++patches === 1 ? task({ title: 'Secret plan' }) : new Response('down', { status: 502 })),
    });
    const result = await callTool('update_task', { task_id: '1', title: 'Secret plan', assignee_id: '999' });
    expect(textOf(result)).toContain('Secret plan');
    const line = lines().slice(-1)[0]!;
    expect(line).toMatchObject({ level: 'error', event: 'mcp.tool', writes: ['PATCH tasks/1'], result: 'failed' });
    expect(JSON.stringify(line)).not.toContain('Secret plan');
  });

  test('a call that saved some changes before failing is a tool error that lists the writes', async () => {
    let patches = 0;
    mockProductive({
      'PATCH tasks/1': () =>
        ++patches === 1 ? task({ title: 'Renamed' }) : Response.json({ errors: [{ detail: 'assignee not found' }] }, { status: 422 }),
    });
    await callTool('update_task', { task_id: '1', title: 'Renamed', assignee_id: '999' });
    expect(lines().slice(-1)[0]).toMatchObject({
      level: 'info',
      event: 'mcp.tool',
      writes: ['PATCH tasks/1'],
      toolError: 'invalid_input',
      toolMessage: 'assignee not found',
      productiveCalls: 2,
      productiveFailed: 1,
      result: 'ok',
    });
  });
});
