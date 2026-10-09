import { describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { hostedTransport, HOSTED_MCP_URL, mcpApiKey } from './mcp-transport';
import { guardMcpApiRequest, run } from './index';

const allowlist = new Set(['fixturethread', 'project:fixtureproject']);
const flags = new Map([['confirm', 'true'], ['client-operation-id', 'fixture-operation'], ['run-id', 'fixture-run']]);

describe('hosted MCP (offline fixtures only)', () => {
  test('API key selection is explicit and fails closed rather than falling back to OAuth', () => {
    expect(mcpApiKey({})).toBeUndefined();
    expect(mcpApiKey({ HOPLITE_API_KEY: 'hop_fixture' })).toBe('hop_fixture');
    expect(mcpApiKey({ HOPLITE_API_KEY: 'hop_svc_fixture' })).toBe('hop_svc_fixture');
    for (const key of ['', 'fixture', 'hop_fixture\n', ' hop_fixture', 'hop_']) {
      expect(() => mcpApiKey({ HOPLITE_API_KEY: key })).toThrow();
    }
  });

  test('central write policy requires confirmation, exact target, explicit matching ID, exact stop run', () => {
    const request = { method: 'POST', path: '/api/threads/fixturethread/stop', body: { clientOperationId: 'fixture-operation', runId: 'fixture-run' } };
    expect(() => guardMcpApiRequest(request, flags, allowlist)).not.toThrow();
    expect(() => guardMcpApiRequest(request, new Map(), allowlist)).toThrow('--confirm');
    expect(() => guardMcpApiRequest(request, new Map([['confirm', 'true']]), allowlist)).toThrow('client-operation-id');
    expect(() => guardMcpApiRequest(request, flags, new Set())).toThrow('disabled');
    expect(() => guardMcpApiRequest(request, flags, new Set(['project:fixtureproject']))).toThrow('allowlist');
    expect(() => guardMcpApiRequest({ ...request, body: { ...request.body, runId: 'other-run' } }, flags, allowlist)).toThrow('run ID');
    expect(() => guardMcpApiRequest({ ...request, body: { ...request.body, clientOperationId: 'other-operation' } }, flags, allowlist)).toThrow('operation ID');
    for (const path of ['/api/threads/fixturethread/../other/stop', '/api/threads/fixturethread%2fstop', '/api/threads/fixturethread/stop?x=1', '//evil.invalid', '/api/threads/fixturethread/pr/merge']) {
      expect(() => guardMcpApiRequest({ ...request, path }, flags, allowlist)).toThrow();
    }
    expect(() => guardMcpApiRequest({ method: 'GET', path: '/api/model-providers' }, new Map(), new Set())).not.toThrow();
    expect(() => guardMcpApiRequest({ method: 'GET', path: '/api/model-providers', body: {} }, flags)).toThrow();
    const create = { method: 'POST', path: '/api/threads', body: { projectId: 'fixtureproject', clientOperationId: 'fixture-operation' } };
    expect(() => guardMcpApiRequest(create, flags, allowlist)).not.toThrow();
    expect(() => guardMcpApiRequest(create, flags, new Set(['fixturethread']))).toThrow('project:');
  });

  test('invalid CLI writes are rejected before any connection', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => { throw new Error('Must not connect'); }, { preconnect: fetch.preconnect }));
    try {
      await expect(run(['mcp-api', '--method', 'POST', '--path', '/api/threads/fixturethread/stop'])).rejects.toThrow('GET/HEAD-only');
      await expect(run(['thread-retry', 'fixturethread'])).rejects.toThrow('--confirm');
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  test('default CLI uses API key with hosted discovery and read coverage; redacts output', async () => {
    const previous = process.env.HOPLITE_API_KEY;
    const priorAllowlist = process.env.HOPLITE_MUTATION_ALLOWLIST;
    process.env.HOPLITE_MUTATION_ALLOWLIST = 'fixturethread,project:fixtureproject';
    process.env.HOPLITE_API_KEY = 'hop_fixture_secret';
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const spy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(HOSTED_MCP_URL);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer hop_fixture_secret');
      expect(init?.redirect).toBe('error');
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : body.method === 'tools/list'
          ? { tools: [{ name: 'hoplite_list_api_operations', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 200, body: { fixture: 'hop_fixture_secret', operations: ['fixture-operation'] } }) }] };
      const reply = { jsonrpc: '2.0', id: body.id, result };
      if (body.method === 'tools/call') {
        return new Response('event: message\ndata: ' + JSON.stringify(reply) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json(reply);
    }, { preconnect: fetch.preconnect }));
    try {
      const discovery = await run(['operations']);
      expect(JSON.stringify(discovery)).not.toContain('hop_fixture_secret');
      expect(calls.some(call => call.params?.name === 'hoplite_list_api_operations')).toBe(true);
      await run(['mcp-api', '--path', '/api/model-providers']);
      expect(calls.some(call => call.params?.name === 'hoplite_call_api')).toBe(true);
      for (const command of [
        ['message', 'fixturethread', '--text', 'fixture message'],
        ['thread-stop', 'fixturethread', '--run-id', 'fixture-run'],
        ['thread-retry', 'fixturethread'],
        ['thread-compact', 'fixturethread'],
        ['thread-auto-title', 'fixturethread'],
        ['create-thread', 'fixtureproject', '--prompt', 'fixture prompt'],
      ]) {
        await run([...command, '--confirm', '--client-operation-id', 'fixture-operation']);
      }
      const writes = calls.filter(call => call.params?.name === 'hoplite_call_api')
        .map(call => call.params!.arguments as { method: string; body: Record<string, unknown> })
        .filter(args => args.method === 'POST');
      expect(writes).toHaveLength(6);
      for (const write of writes) expect(write.body.clientOperationId ?? write.body.clientMessageId).toBe('fixture-operation');
    } finally {
      spy.mockRestore();
      if (priorAllowlist === undefined) delete process.env.HOPLITE_MUTATION_ALLOWLIST; else process.env.HOPLITE_MUTATION_ALLOWLIST = priorAllowlist;
      if (previous === undefined) delete process.env.HOPLITE_API_KEY; else process.env.HOPLITE_API_KEY = previous;
    }
  });

  test('failed HTTP requests are not retried and cannot expose response bodies', async () => {
    let calls = 0;
    const client = new Client({ name: 'fixture', version: '1' });
    const transport = hostedTransport('Bearer fixture', async () => {
      calls++;
      return new Response('fixture-secret', { status: 401 });
    });
    try {
      await expect(client.connect(transport)).rejects.toThrow('MCP HTTP request failed');
      expect(calls).toBe(1);
    } finally { await client.close(); }
  });

  test('oversized MCP responses fail before JSON parsing', async () => {
    const client = new Client({ name: 'fixture', version: '1' });
    try {
      await expect(client.connect(hostedTransport('Bearer fixture', async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))))).rejects.toThrow('2 MiB');
    } finally { await client.close(); }
  });
});
