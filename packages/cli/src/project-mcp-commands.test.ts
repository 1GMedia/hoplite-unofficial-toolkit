import { describe, expect, test } from 'bun:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  buildProjectMcpReadRequest,
  executeProjectMcpRead,
  projectMcpReadProjection,
  redactProjectMcpText,
} from './project-mcp-commands';

function toolResponse(status: number, body: unknown, ok = status >= 200 && status < 300): unknown {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ok, status, body }),
    }],
  };
}

function fakeClient(
  response: unknown,
  calls: Array<{ name: string; arguments?: Record<string, unknown> }>,
): Client {
  return {
    callTool: async (request: { name: string; arguments?: Record<string, unknown> }) => {
      calls.push(request);
      return response;
    },
  } as unknown as Client;
}

describe('project MCP discovery reads', () => {
  test('builds only the two exact GET requests and strictly validates project ids', () => {
    expect(buildProjectMcpReadRequest('project-mcp-list', ['prj_fixture-123'])).toEqual({
      method: 'GET',
      path: '/api/mcp/servers',
      query: { projectId: 'prj_fixture-123' },
    });
    expect(buildProjectMcpReadRequest('project-mcp-catalog', [])).toEqual({
      method: 'GET',
      path: '/api/mcp/catalog',
    });
    for (const projectId of ['', '../other', 'prj/other', 'x'.repeat(129), 'prj bad']) {
      expect(() => buildProjectMcpReadRequest('project-mcp-list', [projectId])).toThrow('project id');
    }
    expect(() => buildProjectMcpReadRequest('project-mcp-list', ['prj_fixture', 'extra'])).toThrow('unexpected positional');
    expect(() => buildProjectMcpReadRequest('project-mcp-catalog', [], new Map([['limit', '10']]))).toThrow('does not accept flags');
    expect(() => buildProjectMcpReadRequest('project-mcp-delete', ['prj_fixture'])).toThrow('Unsupported');
  });

  test('projects server rows without exposing configuration, URLs, commands, or known secrets', () => {
    const secret = 'fixture_access_token_never_print';
    const nameSecret = 'fixture_server_name_secret_never_print';
    const bearerSecret = 'fixture_bearer_server_name_never_print';
    const projected = projectMcpReadProjection('project-mcp-list', {
      servers: [{
        id: 'mcp_server_fixture',
        name: `Private docs at https://internal.example/config {"apiKey":"${nameSecret}"} Bearer ${bearerSecret}`,
        enabled: true,
        authStatus: 'connected',
        updatedAt: '2026-08-25T12:00:00.000Z',
        capabilities: ['search', { name: 'fetch' }],
        config: {
          type: 'streamable-http',
          url: 'https://private.example/mcp?key=must-not-appear',
          headers: { Authorization: `Bearer ${secret}` },
          env: { PRIVATE_TOKEN: secret },
          command: '/private/bin/server',
          args: ['--private-path'],
        },
        credentials: { accessToken: secret },
      }],
    });
    expect(projected.serverCount).toBe(1);
    const output = JSON.stringify(projected);
    expect(output).toContain('streamable-http');
    expect(output).toContain('connected');
    expect(output).toContain('search');
    expect(output).toContain('[url]');
    for (const forbidden of [secret, nameSecret, bearerSecret, 'internal.example', 'private.example', 'Authorization', 'PRIVATE_TOKEN', '/private/bin/server', '--private-path']) {
      expect(output).not.toContain(forbidden);
    }
  });

  test('redacts quoted and unquoted credentials, authorization text, and URLs idempotently', () => {
    const basicSecret = 'fixture_basic_authorization_value';
    const source = [
      '"accessToken": "access_fixture_12345"',
      "'refresh_token'='refresh_fixture_12345'",
      'apiKey: api_fixture_12345',
      'password=[redacted]',
      'client_secret = "client_fixture_12345"',
      'Bearer bearer_fixture_12345',
      `Basic ${basicSecret}`,
      'https://private.example/path?token=url_fixture',
    ].join(' ');
    const once = redactProjectMcpText(source);
    const twice = redactProjectMcpText(once);
    expect(twice).toBe(once);
    expect(once).toContain('"accessToken": "[redacted]"');
    expect(once).toContain('password="[redacted]"');
    expect(once).not.toContain('password="[redacted]"]');
    expect(once).toContain('Bearer [redacted]');
    expect(once).toContain('Basic [redacted]');
    expect(once).toContain('[url]');
    for (const secret of ['access_fixture_12345', 'refresh_fixture_12345', 'api_fixture_12345', 'client_fixture_12345', 'bearer_fixture_12345', basicSecret, 'private.example']) {
      expect(once).not.toContain(secret);
    }
  });

  test('accepts only the evidenced OAuth token container and reports presence without inspecting values', () => {
    const oauthSecret = 'oauth_token_fixture_never_print';
    const connected = projectMcpReadProjection('project-mcp-list', [{
      id: 'mcp_oauth_connected',
      name: 'Connected OAuth server',
      enabled: true,
      config: {
        transport: 'http',
        url: 'https://private.example/mcp',
        auth: {
          grantType: 'authorization_code',
          tokens: {
            accessToken: oauthSecret,
            futureSecretShape: oauthSecret,
          },
        },
      },
    }, {
      id: 'mcp_oauth_pending',
      name: 'Pending OAuth server',
      enabled: true,
      config: {
        transport: 'http',
        url: 'https://private.example/pending',
        auth: { kind: 'oauth2', grantType: 'authorization_code' },
      },
    }, {
      id: 'mcp_oauth_null_tokens',
      name: 'Null OAuth tokens',
      enabled: true,
      config: {
        transport: 'http',
        url: 'https://private.example/null-tokens',
        auth: { kind: 'oauth2', grantType: 'authorization_code', tokens: null },
      },
    }]);
    const output = JSON.stringify(connected);
    expect(output).not.toContain(oauthSecret);
    expect(output).not.toContain('futureSecretShape');
    const servers = connected.servers as Array<Record<string, unknown>>;
    expect(servers[0]?.auth).toEqual({ type: 'oauth', status: 'connected' });
    expect(servers[1]?.auth).toEqual({ type: 'oauth', status: 'pending' });
    expect(servers[2]?.auth).toEqual({ type: 'oauth', status: 'pending' });
    expect(() => projectMcpReadProjection('project-mcp-list', [{
      id: 'mcp_oauth_unknown',
      name: 'Unknown secret shape',
      config: {
        transport: 'http',
        auth: { kind: 'oauth2', otherTokens: { value: oauthSecret } },
      },
    }])).toThrow('unrecognized secret-bearing field');
  });

  test('projects the evidenced bounded catalog entry and pagination metadata', () => {
    const descriptionSecret = 'fixture_catalog_description_secret_never_print';
    const basicSecret = 'fixture_catalog_basic_authorization_never_print';
    const projected = projectMcpReadProjection('project-mcp-catalog', {
      entries: [{
        domain: 'github.com',
        name: 'GitHub',
        description: `Repository tools password="${descriptionSecret}" Basic ${basicSecret} https://private.example/docs`,
        kinds: ['source-control', 'engineering'],
        icon: { light: 'https://private.example/icon.svg' },
        installUrl: 'https://private.example/install',
      }],
      hasMore: false,
      isStale: true,
      nextCursor: 'cursor_not_exposed',
      totalCount: 12,
    });
    expect(projected).toEqual({
      pageCount: 1,
      totalCount: 12,
      hasMore: true,
      nextCursorPresent: true,
      isStale: true,
      catalog: [{
        domain: 'github.com',
        name: 'GitHub',
        description: 'Repository tools password="[redacted]" Basic [redacted] [url]',
        kinds: ['source-control', 'engineering'],
      }],
    });
    expect(JSON.stringify(projected)).not.toContain('private.example');
    expect(JSON.stringify(projected)).not.toContain('cursor_not_exposed');
    expect(JSON.stringify(projected)).not.toContain(descriptionSecret);
    expect(JSON.stringify(projected)).not.toContain(basicSecret);
  });

  test('reports honest catalog page metadata without inventing a global total', () => {
    const noTotal = projectMcpReadProjection('project-mcp-catalog', {
      entries: [{ domain: 'one.example', name: 'One', kinds: [] }],
      hasMore: true,
      isStale: false,
      nextCursor: null,
    });
    expect(noTotal.pageCount).toBe(1);
    expect(noTotal.totalCount).toBeNull();
    expect(noTotal.hasMore).toBe(true);
    expect(noTotal.nextCursorPresent).toBe(false);

    expect(() => projectMcpReadProjection('project-mcp-catalog', {
      entries: [],
      nextCursor: 'x'.repeat(513),
    })).toThrow('nextCursor');
    expect(() => projectMcpReadProjection('project-mcp-catalog', {
      entries: [{ domain: 'one.example', name: 'One', kinds: [] }],
      totalCount: 0,
    })).toThrow('smaller than the current page');
  });

  test('fails closed on unrecognized secret-bearing fields and schema drift', () => {
    expect(() => projectMcpReadProjection('project-mcp-list', {
      servers: [{
        id: 'mcp_server_fixture',
        name: 'Fixture',
        transport: 'http',
        sessionCredentialId: 'credential_fixture',
      }],
    })).toThrow('unrecognized secret-bearing field');
    expect(() => projectMcpReadProjection('project-mcp-list', {
      servers: [{
        id: 'mcp_server_fixture',
        name: 'Fixture',
        transport: 'http',
        extra: { config: { auth: { tokens: { value: 'fixture_nested_secret' } } } },
      }],
    })).toThrow('unrecognized secret-bearing field');
    expect(() => projectMcpReadProjection('project-mcp-list', { data: { id: 'not-an-array' } })).toThrow('servers array is missing');
    const transportSecret = 'sk_live_fixture_transport_secret_123';
    let unsupportedTransportMessage = '';
    try {
      projectMcpReadProjection('project-mcp-list', {
        servers: [{ id: 'mcp_server_fixture', name: 'Fixture', transport: transportSecret }],
      });
    } catch (error) {
      unsupportedTransportMessage = error instanceof Error ? error.message : String(error);
    }
    expect(unsupportedTransportMessage).toBe('project_mcp_response_schema_mismatch: unsupported MCP transport');
    expect(unsupportedTransportMessage).not.toContain(transportSecret);
    expect(() => projectMcpReadProjection('project-mcp-list', {
      servers: [{ id: 'mcp_server_fixture', name: 'Fixture', transport: 'websocket' }],
    })).toThrow('unsupported MCP transport');
    expect(() => projectMcpReadProjection('project-mcp-list', {
      servers: Array.from({ length: 101 }, (_, index) => ({
        id: `server_${index}`,
        name: `Server ${index}`,
        transport: 'http',
      })),
    })).toThrow('exceeds 100 entries');
  });

  test('makes exactly one reviewed tool request and returns an unverified-auth marker', async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const client = fakeClient(toolResponse(200, {
      servers: [{
        id: 'mcp_server_fixture',
        name: 'Fixture server',
        enabled: true,
        config: { type: 'http', url: 'https://private.example/mcp' },
      }],
    }), calls);
    const result = await executeProjectMcpRead(client, 'project-mcp-list', ['prj_fixture'], new Map());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: 'hoplite_call_api',
      arguments: {
        method: 'GET',
        path: '/api/mcp/servers',
        query: { projectId: 'prj_fixture' },
      },
    });
    expect(result.authenticationCompatibility).toBe('unverified');
    expect(result.projectId).toBe('prj_fixture');
    expect(JSON.stringify(result)).not.toContain('private.example');
  });

  test('distinguishes authentication, authorization, resource, route, and generic HTTP failures without retrying', async () => {
    const expectations = [
      ['project-mcp-list', 401, 'unsupported_credential'],
      ['project-mcp-list', 403, 'role_denied'],
      ['project-mcp-list', 404, 'project_or_route_not_found'],
      ['project-mcp-catalog', 404, 'route_not_available'],
      ['project-mcp-catalog', 405, 'route_not_available'],
      ['project-mcp-catalog', 503, 'http_error'],
    ] as const;
    for (const [command, status, code] of expectations) {
      const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
      const client = fakeClient(toolResponse(status, { message: 'private server text' }, false), calls);
      const positionals = command === 'project-mcp-list' ? ['prj_fixture'] : [];
      await expect(executeProjectMcpRead(client, command, positionals, new Map())).rejects.toThrow(code);
      expect(calls).toHaveLength(1);
    }
  });

  test('rejects malformed tool envelopes, invalid JSON, and false success envelopes', async () => {
    const fixtures = [
      {},
      { content: [] },
      { content: [{ type: 'text', text: 'not-json' }] },
      { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: '200', body: [] }) }] },
      { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 200, body: [] }), annotations: { secret: 'private' } }] },
      { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 200, body: [] }) }], structuredContent: { secret: 'private' } },
      { content: [
        { type: 'text', text: JSON.stringify({ ok: true, status: 200, body: [] }) },
        { type: 'image', data: 'private' },
      ] },
      { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 200, body: [], headers: { authorization: 'private' } }) }] },
      { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 200 }) }] },
      toolResponse(200, [], false),
    ];
    for (const fixture of fixtures) {
      const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
      const client = fakeClient(fixture, calls);
      await expect(executeProjectMcpRead(client, 'project-mcp-catalog', [], new Map())).rejects.toThrow();
      expect(calls).toHaveLength(1);
    }
  });

  test('turns transport exceptions into a constant secret-free error without retrying', async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const transportSecret = 'fixture_transport_exception_secret_never_print';
    const client = {
      callTool: async (request: { name: string; arguments?: Record<string, unknown> }) => {
        calls.push(request);
        throw new Error(`Bearer ${transportSecret} https://private.example`);
      },
    } as unknown as Client;
    let message = '';
    try {
      await executeProjectMcpRead(client, 'project-mcp-catalog', [], new Map());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(calls).toHaveLength(1);
    expect(message).toBe('project-mcp-catalog: transport_error; MCP request failed before a validated response');
    expect(message).not.toContain(transportSecret);
    expect(message).not.toContain('private.example');
  });
});
