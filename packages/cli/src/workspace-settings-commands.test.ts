import { describe, expect, test } from 'bun:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { compatibilitySnapshot } from './compatibility';
import type { CommandResult, McpCommandDefinition } from './command-registry';
import { run } from './index';
import {
  workspaceSettingsCommandDefinitions,
} from './workspace-settings-commands';

type ToolRequest = { name: string; arguments?: Record<string, unknown> };
type ToolResponder = (request: ToolRequest) => unknown | Promise<unknown>;

function toolJson(payload: unknown, isError = false): unknown {
  return { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function apiResponse(body: unknown, status = 200): unknown {
  return toolJson({ ok: status >= 200 && status < 300, status, body });
}

async function execute(
  name: string,
  responder: ToolResponder,
  positionals: string[] = [],
  flags = new Map<string, string>(),
): Promise<{ result: CommandResult; calls: ToolRequest[] }> {
  const calls: ToolRequest[] = [];
  const client = {
    callTool: async (request: ToolRequest) => {
      calls.push(request);
      return responder(request);
    },
  } as unknown as Client;
  const command = workspaceSettingsCommandDefinitions.find(candidate => candidate.name === name);
  if (!command || command.transport !== 'mcp') throw new Error(`Missing MCP command ${name}`);
  const result = await (command as McpCommandDefinition).run({ client, positionals, flags });
  return { result, calls };
}

function modelConnection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'connection_fixture',
    kind: 'openrouter',
    name: 'Fixture connection',
    status: 'active',
    version: 1,
    lastVerifiedAt: '2026-08-25T12:00:00.000Z',
    lastError: null,
    models: [{
      id: 'openai/gpt-fixture',
      name: 'GPT Fixture',
      transport: 'responses',
      verified: true,
    }],
    ...overrides,
  };
}

describe('workspace settings commands', () => {
  test('reads the six exact boolean-default paths once with GET only', async () => {
    const { result, calls } = await execute('workspace-defaults-get', request => (
      apiResponse({ ok: true, enabled: request.arguments?.path !== '/api/orgs/agent-task-system' })
    ));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(6);
    expect(calls.map(call => call.arguments)).toEqual([
      { method: 'GET', path: '/api/orgs/public-media-sharing' },
      { method: 'GET', path: '/api/orgs/agent-complaint-reporting' },
      { method: 'GET', path: '/api/orgs/agent-task-system' },
      { method: 'GET', path: '/api/orgs/pr-review-autofix-default' },
      { method: 'GET', path: '/api/orgs/pr-review-auto-merge-default' },
      { method: 'GET', path: '/api/orgs/auto-archive-merged-threads' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PUT|POST|PATCH|DELETE/);
  });

  test('keeps per-default availability distinct instead of inferring product absence', async () => {
    const { result } = await execute('workspace-defaults-get', request => {
      const path = String(request.arguments?.path);
      if (path.endsWith('public-media-sharing')) return apiResponse({}, 403);
      return apiResponse({ ok: true, enabled: true });
    });
    expect(result.ok).toBe(false);
    const defaults = result.defaults as Record<string, CommandResult>;
    expect(defaults.publicMediaSharing).toEqual({
      ok: false,
      path: '/api/orgs/public-media-sharing',
      status: 403,
      outcome: 'role_denied',
    });
    expect(defaults.agentTaskSystem?.ok).toBe(true);
  });

  test('projects null and configured sandbox defaults including runtime profiles', async () => {
    const nullResult = await execute('workspace-sandbox-default-get', () => (
      apiResponse({ ok: true, spec: null, staffCeilings: { maxCpu: 64, maxMemoryGiB: null } })
    ));
    expect(nullResult.result).toMatchObject({ ok: true, configured: false, spec: null });

    const configured = await execute('workspace-sandbox-default-get', () => apiResponse({
      ok: true,
      spec: {
        defaultCpu: 4,
        defaultMemoryGiB: 8,
        maxCpu: null,
        maxDiskGiB: 50,
        runtimeProfile: 'docker-compose',
      },
      staffCeilings: { maxCpu: 64, maxMemoryGiB: 128 },
    }));
    expect(configured.result).toMatchObject({
      ok: true,
      configured: true,
      spec: {
        defaultCpu: 4,
        defaultMemoryGiB: 8,
        maxCpu: null,
        maxDiskGiB: 50,
        runtimeProfile: 'docker-compose',
      },
    });

    const defaultRuntime = await execute('workspace-sandbox-default-get', () => apiResponse({
      ok: true,
      spec: { runtimeProfile: null },
    }));
    expect(defaultRuntime.result).toMatchObject({
      ok: true,
      spec: { runtimeProfile: null },
    });

    const invalidRuntime = await execute('workspace-sandbox-default-get', () => apiResponse({
      ok: true,
      spec: { runtimeProfile: 'microvm' },
    }));
    expect(invalidRuntime.result.outcome).toBe('schema_drift');

    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4']) {
      const checked = await execute('workspace-sandbox-default-get', () => apiResponse({
        ok: true,
        spec: { defaultCpu: invalid },
      }));
      expect(checked.result.outcome).toBe('schema_drift');
    }
  });

  test('reports provider presence only and rejects duplicates or unknown providers', async () => {
    const { result } = await execute('workspace-model-keys-status', () => (
      apiResponse({ ok: true, providers: ['openai'] })
    ));
    expect(result.providers).toEqual([
      { provider: 'anthropic', configured: false },
      { provider: 'openai', configured: true },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/value|token|secret/i);

    for (const providers of [['openai', 'openai'], ['gemini']]) {
      const invalid = await execute('workspace-model-keys-status', () => (
        apiResponse({ ok: true, providers })
      ));
      expect(invalid.result.outcome).toBe('schema_drift');
    }
  });

  test('validates and redacts model-connection projections without exposing lastError', async () => {
    const sensitiveError = 'Authorization: Bearer provider-secret-value';
    const { result } = await execute('workspace-model-connections-list', () => apiResponse({
      ok: true,
      connections: [modelConnection({
        id: 'Authorization: Bearer "fixture bearer phrase"; connection',
        name: 'api_key="fixture secret phrase" Main gateway',
        lastError: sensitiveError,
        models: [{
          id: 'https://models.example/private',
          name: 'password=fixture password phrase GPT',
          transport: 'chat-completions',
          verified: false,
        }],
      })],
    }));
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('provider-secret-value');
    expect(serialized).not.toContain('fixture bearer phrase');
    expect(serialized).not.toContain('fixture secret phrase');
    expect(serialized).not.toContain('fixture password phrase');
    expect(serialized).not.toContain('models.example');
    expect(serialized).not.toContain('lastError');
    expect(serialized).toContain('hasLastError');
  });

  test('redacts bare credentials and secret-label variants from full command output', async () => {
    const { result } = await execute('workspace-model-connections-list', () => apiResponse({
      ok: true,
      connections: [modelConnection({
        id: 'Bearer fixture_connection_token connection-a',
        name: 'Basic Zml4dHVyZS1jb25uZWN0aW9u',
        models: [
          {
            id: 'token=fixture_model_token; model-a',
            name: 'client_secret=fixture_snake_secret; Model A',
            transport: 'responses',
            verified: true,
          },
          {
            id: 'client-secret=fixture_kebab_secret; model-b',
            name: 'clientSecret=fixture_camel_secret; Model B',
            transport: 'chat-completions',
            verified: false,
          },
        ],
      })],
    }));

    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    for (const secret of [
      'fixture_connection_token',
      'Zml4dHVyZS1jb25uZWN0aW9u',
      'fixture_model_token',
      'fixture_snake_secret',
      'fixture_kebab_secret',
      'fixture_camel_secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized.match(/\[redacted\]/g)?.length).toBe(6);
  });

  test('allows only conservative display labels in full command output', async () => {
    const providerCredentials = [
      'sk-proj-fixtureprojectcredential',
      'ghp_fixturegithubcredential',
      'github_pat_fixture_pat_value',
      'AKIAFIXTURE1234567890',
      'AIzaFixtureGoogleCredentialValue12345',
      'xoxb-fixture-slack-credential',
      'sk_live_fixturestripecredential',
      'whsec_fixturewebhookcredential',
      'glpat-fixturegitlabcredential',
      'hf_fixturehuggingfacecredential',
    ];
    const unsafeLabels = [
      ...providerCredentials,
      'providerApiKey=fixture',
      'workspace_api_key=fixture',
      'account-api-key=fixture',
      'prefixClientSecret=fixture',
      'provider_client_secret=fixture',
      'account-client-secret=fixture',
      'workspaceAuthToken=fixture',
      'provider_auth_token=fixture',
      'account-auth-token=fixture',
      'STRIPE_KEY',
      'providerKey',
      'https://models.example/private',
      'models.example/private',
      'api.vendor.io/v1/models',
      'fixture-user:fixture-value',
      '0123456789abcdefABCD',
      'abcdefghijklmnopqrstuvwx',
      'AbCdEfGhIjKlMnOpQrStUv12_34',
      'opaque_abcdefghijklmnopqrstuvwxyz1234567890',
      'unsafe@example.com',
    ];
    const safeLabels = [
      'Fixture Gateway 2',
      'openai/gpt-5.6',
      'claude-sonnet-4-5-20250929',
    ];
    const labels = [...unsafeLabels, ...safeLabels];
    const models = labels.map((label, index) => ({
      id: `model-${index}`,
      name: label,
      transport: index % 2 === 0 ? 'responses' : 'chat-completions',
      verified: index % 2 === 0,
    }));
    const { result } = await execute('workspace-model-connections-list', () => apiResponse({
      ok: true,
      connections: [modelConnection({
        id: 'connection_fixture',
        name: 'Fixture Gateway 2',
        models,
      })],
    }));

    expect(result.ok).toBe(true);
    const connection = (result.connections as Array<Record<string, unknown>>)[0]!;
    expect(connection.id).toBe('connection_fixture');
    expect(connection.name).toBe('Fixture Gateway 2');
    const projectedModels = connection.models as Array<Record<string, unknown>>;
    expect(projectedModels.slice(0, unsafeLabels.length).every(model => model.name === '[redacted]')).toBe(true);
    expect(projectedModels.slice(unsafeLabels.length).map(model => model.name)).toEqual(safeLabels);
    expect(projectedModels.map(model => model.id)).toEqual(
      labels.map((_label, index) => `model-${index}`),
    );
    const serialized = JSON.stringify(result);
    for (const value of unsafeLabels) expect(serialized).not.toContain(value);
  });

  test('rejects model-connection enum, version, date, shape, and array drift', async () => {
    const invalidConnections = [
      modelConnection({ kind: 'other' }),
      modelConnection({ status: 'pending' }),
      modelConnection({ version: 0 }),
      modelConnection({ version: 1.2 }),
      modelConnection({ lastVerifiedAt: 'yesterday' }),
      modelConnection({ lastError: 42 }),
      modelConnection({ models: [{ id: 'm', name: 'm', transport: 'other', verified: true }] }),
      modelConnection({ models: [{ id: 'm', name: 'm', transport: 'responses', verified: 'yes' }] }),
      { ...modelConnection(), unexpected: true },
    ];
    for (const connection of invalidConnections) {
      const checked = await execute('workspace-model-connections-list', () => (
        apiResponse({ ok: true, connections: [connection] })
      ));
      expect(checked.result.outcome).toBe('schema_drift');
    }

    const tooManyConnections = Array.from({ length: 101 }, (_, index) => (
      modelConnection({ id: `connection_${index}` })
    ));
    const connectionsChecked = await execute('workspace-model-connections-list', () => (
      apiResponse({ ok: true, connections: tooManyConnections })
    ));
    expect(connectionsChecked.result.outcome).toBe('schema_drift');

    const tooManyModels = Array.from({ length: 201 }, (_, index) => ({
      id: `model_${index}`,
      name: `Model ${index}`,
      transport: 'responses',
      verified: true,
    }));
    const modelsChecked = await execute('workspace-model-connections-list', () => (
      apiResponse({ ok: true, connections: [modelConnection({ models: tooManyModels })] })
    ));
    expect(modelsChecked.result.outcome).toBe('schema_drift');
  });

  test('distinguishes credential, subscription, role, absence, deployment, and generic failures', async () => {
    const expected = new Map<number, string>([
      [401, 'unsupported_credential'],
      [402, 'subscription_required'],
      [403, 'role_denied'],
      [404, 'absent_or_unavailable'],
      [501, 'deployment_unavailable'],
      [500, 'request_failed'],
    ]);
    for (const [status, outcome] of expected) {
      const { result, calls } = await execute('workspace-sandbox-default-get', () => apiResponse({}, status));
      expect(result).toMatchObject({ ok: false, status, outcome });
      expect(calls).toHaveLength(1);
    }
  });

  test('classifies HTTP 200 schema mismatch separately and does not retry transport errors', async () => {
    const drift = await execute('workspace-model-keys-status', () => apiResponse({ ok: true, providers: ['openai'], key: 'never' }));
    expect(drift.result.outcome).toBe('schema_drift');

    const malformed = await execute('workspace-model-keys-status', () => ({ content: [] }));
    expect(malformed.result.outcome).toBe('request_failed');

    const rejected = await execute('workspace-model-keys-status', () => {
      throw new Error('fixture transport failure');
    });
    expect(rejected.result.outcome).toBe('request_failed');
    expect(rejected.calls).toHaveLength(1);
  });

  test('rejects unsafe MCP envelopes, tool errors, and oversized text before parsing', async () => {
    const successPayload = { ok: true, status: 200, body: { ok: true, providers: [] } };
    const inheritedIsError = Object.assign(Object.create({ isError: false }), {
      content: [{ type: 'text', text: JSON.stringify(successPayload) }],
    });
    for (const envelope of [
      toolJson(successPayload, true),
      { content: [{ type: 'text', text: JSON.stringify(successPayload) }] },
      inheritedIsError,
      { isError: 'false', content: [{ type: 'text', text: JSON.stringify(successPayload) }] },
      { isError: false, content: [{ type: 'text', text: JSON.stringify(successPayload) }], extra: true },
      { isError: false, content: [{ type: 'text', text: JSON.stringify(successPayload), annotations: {} }] },
      { isError: false, content: [
        { type: 'text', text: JSON.stringify(successPayload) },
        { type: 'text', text: '{}' },
      ] },
      toolJson({ ...successPayload, extra: true }),
      toolJson({ ok: 'true', status: 200, body: { ok: true, providers: [] } }),
      toolJson({ ok: true, status: '200', body: { ok: true, providers: [] } }),
      toolJson({ ok: true, status: 200 }),
    ]) {
      const checked = await execute('workspace-model-keys-status', () => envelope);
      expect(checked.result.outcome).toBe('request_failed');
    }

    const oversized = JSON.stringify({
      ok: true,
      status: 200,
      body: { ok: true, providers: [], padding: 'x'.repeat(2 * 1024 * 1024) },
    });
    const checked = await execute('workspace-model-keys-status', () => ({
      isError: false,
      content: [{ type: 'text', text: oversized }],
    }));
    expect(checked.result.outcome).toBe('request_failed');
    expect(checked.calls).toHaveLength(1);

    const inconsistent = await execute('workspace-model-keys-status', () => (
      toolJson({ ok: true, status: 403, body: {} })
    ));
    expect(inconsistent.result.outcome).toBe('request_failed');
  });

  test('rejects unexpected positionals and flags before any request', async () => {
    const positional = execute('workspace-model-keys-status', () => apiResponse({}), ['unexpected']);
    await expect(positional).rejects.toThrow('does not accept positional');
    const flagged = execute(
      'workspace-model-connections-list',
      () => apiResponse({}),
      [],
      new Map([['secret', 'fixture']]),
    );
    await expect(flagged).rejects.toThrow('does not accept flags');
  });

  test('registers all commands in help and records reads as implemented while writes stay blocked', async () => {
    const help = await run(['help']);
    const commands = help.commands as Record<string, string>;
    for (const command of workspaceSettingsCommandDefinitions) {
      expect(commands[command.name]).toBe(command.description);
    }

    const registry = new Map(compatibilitySnapshot().capabilities.map(entry => [entry.id, entry]));
    for (const id of [
      'workspace.public-media-sharing.get',
      'workspace.agent-complaint-reporting.get',
      'workspace.agent-task-system.get',
      'workspace.pr-review-autofix-default.get',
      'workspace.pr-review-auto-merge-default.get',
      'workspace.auto-archive-merged-threads.get',
      'workspace.sandbox-defaults.get',
      'workspace.model-keys.list',
      'workspace.model-connections.list',
    ]) {
      expect(registry.get(id)?.status).toBe('implemented');
      expect(registry.get(id)?.risk).toBe('R0');
    }
    for (const id of [
      'workspace.organization.update',
      'workspace.sandbox-defaults.set',
      'workspace.model-keys.set',
      'workspace.model-keys.delete',
      'workspace.model-connections.create',
      'workspace.model-connections.update',
      'workspace.model-connections.delete',
    ]) {
      expect(registry.get(id)?.status).toBe('blocked');
      expect(registry.get(id)?.risk).not.toBe('R0');
    }
    expect(registry.get('workspace.model-connections.update')?.path)
      .toBe('/api/model-connections/:connectionId');
    expect(registry.get('workspace.model-connections.delete')?.path)
      .toBe('/api/model-connections/:connectionId');
  });
});
