import { describe, expect, test } from 'bun:test';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { McpCommandDefinition } from './command-registry';
import { compatibilitySnapshot } from './compatibility';
import {
  classifyIntegrationFailure,
  integrationStatusCommandDefinitions,
  parseIntegrationToolApiEnvelope,
  parseSourceControlConnections,
} from './integration-status-commands';

type JsonObject = Record<string, unknown>;

function toolResult(body: unknown, status = 200): JsonObject {
  return {
    isError: false,
    content: [{
      type: 'text',
      text: JSON.stringify({ ok: status === 200, status, body }),
    }],
  };
}

function command(name: string): McpCommandDefinition {
  const definition = integrationStatusCommandDefinitions.find(candidate => candidate.name === name);
  if (!definition || definition.transport !== 'mcp') throw new Error(`Missing MCP command ${name}`);
  return definition;
}

async function runCommand(
  name: string,
  result: unknown,
  options: {
    positionals?: string[];
    flags?: Map<string, string>;
    rejectWith?: unknown;
  } = {},
): Promise<{ calls: JsonObject[]; output: JsonObject }> {
  const calls: JsonObject[] = [];
  const client = {
    callTool: async (...args: unknown[]) => {
      calls.push(args[0] as JsonObject);
      if (options.rejectWith !== undefined) throw options.rejectWith;
      return result;
    },
  } as unknown as Client;
  const output = await command(name).run({
    client,
    positionals: options.positionals ?? [],
    flags: options.flags ?? new Map(),
  });
  return { calls, output };
}

const SOURCE_CONNECTION = {
  accountName: 'Example Org',
  accountType: 'organization',
  apiBaseUrl: 'https://provider.example/api?access_token=fixture-secret',
  credentialKind: 'oauth_token',
  externalId: 'external-provider-id',
  host: 'provider.example',
  id: 'conn_example',
  provider: 'github',
  updatedAt: '2026-08-26T00:00:00.000Z',
};

const SOURCE_REPOSITORY = {
  accountName: 'Example Org',
  apiBaseUrl: 'https://provider.example/api?token=fixture-secret',
  cloneUrl: 'https://fixture-secret@provider.example/example/repo.git',
  connectionId: 'conn_example',
  defaultBranch: 'main',
  externalId: 'external-repository-id',
  fullName: 'example/repo',
  host: 'provider.example',
  id: 'repo_example',
  language: 'TypeScript',
  private: true,
  provider: 'github',
};

describe('integration status commands', () => {
  test('withholds binding writes whose exact payload schemas are not evidenced', () => {
    const capabilityIds = new Set(compatibilitySnapshot().capabilities.map(entry => entry.id));
    for (const id of [
      'project.slack-binding.upsert',
      'project.linear-binding.upsert',
      'project.sentry-binding.upsert',
    ]) expect(capabilityIds.has(id)).toBe(false);
  });

  test('counts source-control connections once without emitting items or identifiers', async () => {
    const { calls, output } = await runCommand(
      'source-control-connections',
      toolResult({ ok: true, connections: [SOURCE_CONNECTION] }),
    );
    expect(calls).toEqual([{
      name: 'hoplite_call_api',
      arguments: { method: 'GET', path: '/api/source-control/connections' },
    }]);
    expect(output).toEqual({
      ok: true,
      status: 200,
      surface: 'source-control-connections',
      availability: 'confirmed_for_current_credential',
      totalCount: 1,
      connectedCount: 1,
      providerCounts: { github: 1 },
    });
    const printed = JSON.stringify(output);
    for (const secret of Object.values(SOURCE_CONNECTION)) {
      if (typeof secret !== 'string' || secret === 'github') continue;
      expect(printed).not.toContain(secret);
    }
    expect(output.items).toBeUndefined();
  });

  test('counts repositories once by fixed provider and visibility without emitting items', async () => {
    const { calls, output } = await runCommand(
      'source-control-repositories',
      toolResult({ ok: true, repositories: [SOURCE_REPOSITORY] }),
    );
    expect(calls[0]).toEqual({
      name: 'hoplite_call_api',
      arguments: { method: 'GET', path: '/api/source-control/repositories' },
    });
    expect(output).toMatchObject({
      totalCount: 1,
      providerCounts: { github: 1 },
      visibilityCounts: { private: 1, public: 0 },
    });
    const printed = JSON.stringify(output);
    for (const secret of Object.values(SOURCE_REPOSITORY)) {
      if (typeof secret !== 'string' || secret === 'github') continue;
      expect(printed).not.toContain(secret);
    }
    expect(output.items).toBeUndefined();
  });

  test('uses the exact optional projectId query for Slack status', async () => {
    const { calls, output } = await runCommand(
      'slack-status',
      toolResult({
        ok: true,
        slack: {
          configured: true,
          missingConfig: [],
          requiredScopes: ['channels:read'],
          installations: [{
            teamId: 'team_example',
            teamName: 'Example Workspace',
            scope: 'channels:read,groups:read',
          }],
          projectBinding: {
            teamId: 'team_example',
            channelId: 'channel_example',
            channelName: 'agent-work',
            enabled: true,
          },
        },
      }),
      { flags: new Map([['project', 'prj_example']]) },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: 'hoplite_call_api',
      arguments: {
        method: 'GET',
        path: '/api/slack/status',
        query: { projectId: 'prj_example' },
      },
    });
    expect(output).toMatchObject({
      totalCount: 1,
      connectedCount: 1,
      configuredCount: 1,
      bindingPresentCount: 1,
      enabledCount: 1,
      disabledCount: 0,
      requiredScopeCount: 1,
      missingConfigCount: 0,
    });
    const serialized = JSON.stringify(output);
    for (const value of ['team_example', 'Example Workspace', 'channel_example', 'agent-work', 'channels:read']) {
      expect(serialized).not.toContain(value);
    }
  });

  test('omits the project query entirely when no project is supplied', async () => {
    const { calls, output } = await runCommand(
      'linear-status',
      toolResult({
        ok: true,
        linear: {
          configured: true,
          installations: [{ workspaceId: 'workspace_example', workspaceName: 'Example Linear' }],
          projectBinding: null,
        },
      }),
    );
    expect(calls).toEqual([{
      name: 'hoplite_call_api',
      arguments: { method: 'GET', path: '/api/linear/status' },
    }]);
    expect(output).toMatchObject({
      totalCount: 1,
      connectedCount: 1,
      configuredCount: 1,
      bindingPresentCount: 0,
      enabledCount: 0,
      disabledCount: 0,
    });
    expect(JSON.stringify(output)).not.toContain('workspace_example');
    expect(JSON.stringify(output)).not.toContain('Example Linear');
  });

  test('counts bounded Sentry installation and binding status', async () => {
    const { calls, output } = await runCommand(
      'sentry-status',
      toolResult({
        ok: true,
        sentry: {
          configured: true,
          installations: [{
            installationId: 'installation_example',
            organizationSlug: 'example-org',
            organizationName: 'Example Org',
            status: 'connected',
          }],
          projectBindings: [{
            id: 'binding_example',
            installationId: 'installation_example',
            sentryProjectId: 'project_example',
            sentryProjectSlug: 'web-app',
            sentryProjectName: 'Web App',
            enabled: true,
            triggerPolicy: { newIssues: true, regressions: false, levels: ['error'] },
          }],
        },
      }),
      { flags: new Map([['project', 'prj_example']]) },
    );
    expect(calls).toHaveLength(1);
    expect(output).toMatchObject({
      totalCount: 1,
      connectedCount: 1,
      configuredCount: 1,
      bindingPresentCount: 1,
      enabledCount: 1,
      disabledCount: 0,
      statusCounts: { connected: 1, needs_reauth: 0 },
    });
    const serialized = JSON.stringify(output);
    for (const value of [
      'installation_example', 'example-org', 'Example Org', 'binding_example', 'project_example',
      'web-app', 'Web App', 'error',
    ]) expect(serialized).not.toContain(value);
  });

  test('redacts phone identifiers and pairing URLs by construction', async () => {
    const { calls, output } = await runCommand(
      'phone-status',
      toolResult({
        ok: true,
        connection: {
          connected: true,
          phoneNumber: '+15555550123',
          handles: ['user@example.test', '+15555550123'],
          pairingRedirectUrl: 'https://pairing.example/?token=fixture-secret',
          pairingUnavailableReason: null,
        },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(output).toEqual({
      ok: true,
      status: 200,
      surface: 'phone',
      availability: 'confirmed_for_current_credential',
      totalCount: 1,
      connectedCount: 1,
      configuredCount: 1,
      pairingPendingCount: 1,
      pairingUnavailableReasonCounts: {
        rate_limited: 0,
        not_configured: 0,
        temporarily_unavailable: 0,
        invalid_phone_number: 0,
        phone_number_taken: 0,
      },
    });
    const printed = JSON.stringify(output);
    for (const secret of ['+15555550123', 'user@example.test', 'pairing.example', 'fixture-secret']) {
      expect(printed).not.toContain(secret);
    }
  });

  test('distinguishes compatibility failure statuses without retaining bodies', async () => {
    const expected = new Map([
      [401, 'unsupported_credential'],
      [402, 'payment_required'],
      [403, 'permission_denied'],
      [404, 'route_or_resource_unavailable'],
      [405, 'method_not_allowed'],
      [429, 'rate_limited'],
      [501, 'not_implemented'],
    ]);
    for (const [status, outcome] of expected) {
      expect(classifyIntegrationFailure(status, 'slack').outcome).toBe(outcome);
      const { calls, output } = await runCommand(
        'slack-status',
        toolResult({
          error: 'provider-secret-body',
          loginUrl: 'https://provider.example/oauth?state=secret',
        }, status),
      );
      expect(calls).toHaveLength(1);
      expect(output.outcome).toBe(outcome);
      expect(JSON.stringify(output)).not.toContain('provider-secret-body');
      expect(JSON.stringify(output)).not.toContain('provider.example');
    }
  });

  test('returns a constant transport error and does not retry', async () => {
    for (const error of [
      new Error('Bearer fixture-secret https://provider.example/private'),
      new Error('different provider payload'),
    ]) {
      const { calls, output } = await runCommand(
        'phone-status',
        {},
        { rejectWith: error },
      );
      expect(calls).toHaveLength(1);
      expect(output).toEqual({
        ok: false,
        status: 0,
        surface: 'phone',
        outcome: 'transport_error',
        availability: 'unknown',
        message: 'The integration read could not be completed through the current MCP transport.',
      });
    }
  });

  test('rejects unknown flags, positionals, and invalid project ids before transport', async () => {
    const client = { callTool: async () => { throw new Error('must not call'); } } as unknown as Client;
    expect(() => command('phone-status').run({
      client,
      positionals: ['unexpected'],
      flags: new Map(),
    })).toThrow('does not accept positional');
    expect(() => command('source-control-connections').run({
      client,
      positionals: [],
      flags: new Map([['project', 'prj_example']]),
    })).toThrow('does not support --project');
    expect(() => command('slack-status').run({
      client,
      positionals: [],
      flags: new Map([['project', '../not-valid']]),
    })).toThrow('valid --project id');
    expect(() => command('linear-status').run({
      client,
      positionals: [],
      flags: new Map([['project', 'true']]),
    })).toThrow('valid --project id');
  });

  test('fails closed on oversized MCP text, row counts, and strings', async () => {
    expect(() => parseIntegrationToolApiEnvelope({
      isError: false,
      content: [{ type: 'text', text: 'x'.repeat(512 * 1024 + 1) }],
    })).toThrow('integration_status_response_schema_mismatch');
    expect(() => parseSourceControlConnections({
      ok: true,
      connections: Array.from({ length: 251 }, () => SOURCE_CONNECTION),
    })).toThrow('integration_status_response_schema_mismatch');
    expect(() => parseSourceControlConnections({
      ok: true,
      connections: [{ ...SOURCE_CONNECTION, accountName: 'x'.repeat(513) }],
    })).toThrow('integration_status_response_schema_mismatch');
  });

  test('rejects whitespace-only values in every GitHub connection string field', () => {
    for (const field of Object.keys(SOURCE_CONNECTION)) {
      expect(() => parseSourceControlConnections({
        ok: true,
        connections: [{ ...SOURCE_CONNECTION, [field]: '   ' }],
      }), field).toThrow('integration_status_response_schema_mismatch');
    }
  });

  test('requires exactly one JSON text item and an exact API envelope', () => {
    const validText = JSON.stringify({ ok: true, status: 200, body: {} });
    for (const result of [
      { content: [{ type: 'text', text: validText }] },
      Object.assign(Object.create({ isError: false }), { content: [{ type: 'text', text: validText }] }),
      Object.assign(Object.create({ content: [{ type: 'text', text: validText }] }), { isError: false }),
      { isError: 'false', content: [{ type: 'text', text: validText }] },
      { isError: true, content: [{ type: 'text', text: validText }] },
      { isError: false, content: [] },
      { isError: false, content: [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }] },
      { isError: false, content: [{ type: 'image', data: 'fixture' }] },
      { isError: false, content: [Object.assign(Object.create({ type: 'text' }), { text: validText })] },
      { isError: false, content: [{ type: 'text', text: validText, extra: true }] },
      { isError: false, content: [{ type: 'text', text: '{not-json}' }] },
      { isError: false, content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 200, body: {}, extra: true }) }] },
    ]) {
      expect(() => parseIntegrationToolApiEnvelope(result)).toThrow(
        'integration_status_response_schema_mismatch',
      );
    }
  });

  test('fails closed on extra raw fields and unknown fixed enums', async () => {
    for (const [name, body] of [
      ['source-control-connections', { ok: true, connections: [{ ...SOURCE_CONNECTION, extra: true }] }],
      ['source-control-connections', { ok: true, connections: [{ ...SOURCE_CONNECTION, provider: 'unknown' }] }],
      ['source-control-repositories', { ok: true, repositories: [{ ...SOURCE_REPOSITORY, extra: true }] }],
      ['source-control-repositories', {
        ok: true,
        repositories: [Object.fromEntries(
          Object.entries(SOURCE_REPOSITORY).filter(([key]) => key !== 'language'),
        )],
      }],
      ['slack-status', {
        ok: true,
        slack: {
          configured: true,
          missingConfig: [],
          requiredScopes: [],
          installations: [{ teamId: 'team', teamName: null, scope: null, extra: true }],
          projectBinding: null,
        },
      }],
      ['linear-status', {
        ok: true,
        linear: {
          configured: true,
          installations: [{ workspaceId: 'workspace', workspaceName: null }],
          projectBinding: { workspaceId: 'workspace', teamId: null, teamName: null, linearProjectId: null, linearProjectName: null, enabled: true, extra: true },
        },
      }],
      ['sentry-status', {
        ok: true,
        sentry: {
          configured: true,
          installations: [{ installationId: 'install', organizationSlug: 'org', organizationName: null, status: 'unknown' }],
          projectBindings: [],
        },
      }],
      ['phone-status', {
        ok: true,
        connection: { connected: false, phoneNumber: null, handles: [], pairingRedirectUrl: null, pairingUnavailableReason: null, extra: true },
      }],
    ] as const) {
      const checked = await runCommand(name, toolResult(body));
      expect(checked.output.outcome).toBe('schema_drift');
    }
  });
});
