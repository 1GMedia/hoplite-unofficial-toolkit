import { describe, expect, test } from 'bun:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { compatibilitySnapshot } from './compatibility';
import type { CommandResult, McpCommandDefinition } from './command-registry';
import { run } from './index';
import { projectAutomationCommandDefinitions } from './project-automation-commands';

type ToolRequest = { name: string; arguments?: Record<string, unknown> };
type ToolResponder = (request: ToolRequest) => unknown | Promise<unknown>;

function toolJson(payload: unknown, isError = false): unknown {
  return { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function apiResponse(body: unknown, status = 200): unknown {
  return toolJson({ ok: status >= 200 && status < 300, status, body });
}

function automation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'aut_fixture1',
    projectId: 'prj_fixture1',
    name: 'Nightly dependency audit',
    enabled: true,
    triggerKind: 'schedule',
    schedule: { mode: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' },
    prompt: 'fixture private prompt that must never be projected',
    title: 'fixture private run title',
    maxSpendPerThreadMicros: 250000,
    webhookTokenPrefix: null,
    nextRunAt: '2026-08-27T09:00:00.000Z',
    lastRunAt: '2026-08-26T09:00:00.000Z',
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-25T12:00:00.000Z',
    ...overrides,
  };
}

function execution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'exe_fixture1',
    automationId: 'aut_fixture1',
    projectId: 'prj_fixture1',
    triggerKind: 'schedule',
    dedupeKey: 'fixture-private-dedupe-key',
    status: 'thread_created',
    threadId: 'thr_fixture1',
    error: null,
    payloadSummary: { externalUrl: 'https://alerts.example/private', recipient: 'fixture@example.com' },
    createdAt: '2026-08-26T09:00:00.000Z',
    updatedAt: '2026-08-26T09:02:00.000Z',
    threadTitle: 'fixture private thread title',
    runDurationMs: 120000,
    ...overrides,
  };
}

async function execute(
  name: string,
  responder: ToolResponder,
  positionals: string[],
  flags = new Map<string, string>(),
): Promise<{ result: CommandResult; calls: ToolRequest[] }> {
  const calls: ToolRequest[] = [];
  const client = {
    callTool: async (request: ToolRequest) => {
      calls.push(request);
      return responder(request);
    },
  } as unknown as Client;
  const command = projectAutomationCommandDefinitions.find(candidate => candidate.name === name);
  if (!command || command.transport !== 'mcp') throw new Error(`Missing MCP command ${name}`);
  const result = await (command as McpCommandDefinition).run({ client, positionals, flags });
  return { result, calls };
}

describe('project automation commands', () => {
  test('lists bounded automation metadata in one GET without projecting private fields', async () => {
    const privateValues = [
      'fixture private prompt that must never be projected',
      'fixture private run title',
      'hwa2_fixture123',
      'https://alerts.example/private',
    ];
    const { result, calls } = await execute(
      'project-automations-list',
      () => apiResponse({
        ok: true,
        automations: [
          automation(),
          automation({
            id: 'aut_fixture2',
            name: 'AbCdEfGhIjKlMnOpQrStUv12_34',
            triggerKind: 'webhook',
            schedule: null,
            prompt: privateValues[0],
            title: privateValues[3],
            maxSpendPerThreadMicros: null,
            webhookTokenPrefix: privateValues[2],
            nextRunAt: null,
            lastRunAt: null,
          }),
        ],
      }),
      ['prj_fixture1'],
    );

    expect(calls).toEqual([{
      name: 'hoplite_call_api',
      arguments: { method: 'GET', path: '/api/projects/prj_fixture1/automations' },
    }]);
    expect(result).toMatchObject({
      ok: true,
      count: 2,
      enabledCount: 2,
      triggerCounts: { schedule: 1, webhook: 1 },
    });
    const projected = result.automations as Array<Record<string, unknown>>;
    expect(projected[0]).toMatchObject({
      id: 'aut_fixture1',
      name: 'Nightly dependency audit',
      triggerKind: 'schedule',
      schedule: { mode: 'cron', timezone: 'UTC' },
      hasTitle: true,
      hasSpendLimit: true,
      webhookCredentialConfigured: false,
    });
    expect(projected[1]).toMatchObject({
      id: 'aut_fixture2',
      name: '[redacted]',
      triggerKind: 'webhook',
      schedule: null,
      webhookCredentialConfigured: true,
    });
    const serialized = JSON.stringify(result);
    for (const value of privateValues) expect(serialized).not.toContain(value);
    for (const key of ['prompt', 'title', 'webhookTokenPrefix', 'maxSpendPerThreadMicros']) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  test('gets one automation by filtering the evidenced list in one call', async () => {
    const { result, calls } = await execute(
      'project-automation-get',
      () => apiResponse({
        ok: true,
        automations: [automation(), automation({ id: 'aut_fixture2', name: 'Weekly checks' })],
      }),
      ['prj_fixture1', 'aut_fixture2'],
    );
    expect(calls).toHaveLength(1);
    expect((result.automation as Record<string, unknown>).id).toBe('aut_fixture2');

    const missing = await execute(
      'project-automation-get',
      () => apiResponse({ ok: true, automations: [automation()] }),
      ['prj_fixture1', 'aut_missing'],
    );
    expect(missing.result).toMatchObject({ ok: false, status: 200, outcome: 'not_found' });
    expect(missing.calls).toHaveLength(1);
  });

  test('redacts adversarial credential and network-like automation names', async () => {
    const unsafeNames = [
      'sk-proj-AbcDef123456',
      'Bearer fixturevalue',
      'api.vendor.io/private',
      '10.0.0.1/private',
      'STRIPE_KEY',
    ];
    const { result } = await execute(
      'project-automations-list',
      () => apiResponse({
        ok: true,
        automations: unsafeNames.map((name, index) => automation({ id: `aut_unsafe${index}`, name })),
      }),
      ['prj_fixture1'],
    );
    const projected = result.automations as Array<Record<string, unknown>>;
    expect(projected.every(item => item.name === '[redacted]')).toBe(true);
    const serialized = JSON.stringify(result);
    for (const value of unsafeNames) expect(serialized).not.toContain(value);
  });

  test('projects status counts while suppressing private last errors', async () => {
    const privateError = 'fixture private provider error https://alerts.example/private';
    const { result, calls } = await execute(
      'project-automations-status',
      () => apiResponse({
        ok: true,
        statuses: [{
          automationId: 'aut_fixture1',
          lastStatus: 'failed',
          lastError: privateError,
          lastExecutionAt: '2026-08-26T09:00:00.000Z',
          runs30d: 10,
          succeeded30d: 9,
        }],
        totals: { runs30d: 10, succeeded30d: 9 },
      }),
      ['prj_fixture1'],
    );
    expect(calls).toEqual([{
      name: 'hoplite_call_api',
      arguments: { method: 'GET', path: '/api/projects/prj_fixture1/automations/status' },
    }]);
    expect(result).toMatchObject({
      ok: true,
      totals: { runs30d: 10, succeeded30d: 9 },
      statuses: [{ automationId: 'aut_fixture1', lastStatus: 'failed', hasLastError: true }],
    });
    expect(JSON.stringify(result)).not.toContain(privateError);
    expect(JSON.stringify(result)).not.toContain('lastError');
  });

  test('lists bounded execution receipts without payloads, dedupe keys, titles, or errors', async () => {
    const privateError = 'fixture private run error';
    const { result, calls } = await execute(
      'project-automation-runs-list',
      () => apiResponse({
        ok: true,
        executions: [execution(), execution({
          id: 'exe_fixture2',
          status: 'failed',
          threadId: null,
          error: privateError,
          payloadSummary: { recipient: 'private@example.com' },
          threadTitle: 'private failed title',
          runDurationMs: null,
        })],
      }),
      ['prj_fixture1', 'aut_fixture1'],
      new Map([['limit', '2']]),
    );
    expect(calls).toEqual([{
      name: 'hoplite_call_api',
      arguments: {
        method: 'GET',
        path: '/api/projects/prj_fixture1/automations/aut_fixture1/executions?limit=2',
      },
    }]);
    expect(result).toMatchObject({
      ok: true,
      count: 2,
      executions: [
        { id: 'exe_fixture1', status: 'thread_created', threadId: 'thr_fixture1', hasPayload: true },
        { id: 'exe_fixture2', status: 'failed', threadId: null, hasError: true },
      ],
    });
    const serialized = JSON.stringify(result);
    for (const value of [
      'fixture-private-dedupe-key',
      privateError,
      'private@example.com',
      'private failed title',
      'alerts.example',
    ]) expect(serialized).not.toContain(value);
    for (const key of ['dedupeKey', 'payloadSummary', 'threadTitle', 'error']) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  test('distinguishes auth, subscription, role, absence, deployment, and generic failures', async () => {
    const expected = new Map<number, string>([
      [401, 'unsupported_credential'],
      [402, 'subscription_required'],
      [403, 'role_denied'],
      [404, 'absent_or_unavailable'],
      [501, 'deployment_unavailable'],
      [500, 'request_failed'],
    ]);
    for (const [status, outcome] of expected) {
      const checked = await execute(
        'project-automations-list',
        () => apiResponse({}, status),
        ['prj_fixture1'],
      );
      expect(checked.result).toMatchObject({ ok: false, status, outcome });
      expect(checked.calls).toHaveLength(1);
    }
  });

  test('fails closed on envelope, schema, target, row, and byte drift without retries', async () => {
    const driftBodies = [
      { ok: true, automations: [{ ...automation(), extra: true }] },
      { ok: true, automations: [automation({ projectId: 'prj_other' })] },
      { ok: true, automations: [automation({ triggerKind: 'email' })] },
      { ok: true, automations: [automation({ schedule: { mode: 'cron', expression: '99 99 * * *', timezone: 'UTC' } })] },
      { ok: true, automations: [automation({ schedule: { mode: 'cron', expression: '0 9 * * 1', timezone: 'Not/AZone' } })] },
      { ok: true, automations: [automation({ prompt: 42 })] },
      { ok: true, automations: [automation(), automation()] },
      { ok: true, automations: Array.from({ length: 101 }, (_, index) => automation({ id: `aut_${index}` })) },
      { ok: true, automations: [], extra: true },
    ];
    for (const body of driftBodies) {
      const checked = await execute(
        'project-automations-list',
        () => apiResponse(body),
        ['prj_fixture1'],
      );
      expect(checked.result.outcome).toBe('schema_drift');
      expect(checked.calls).toHaveLength(1);
    }

    const malformed = await execute(
      'project-automations-list',
      () => ({ isError: false, content: [] }),
      ['prj_fixture1'],
    );
    expect(malformed.result.outcome).toBe('request_failed');

    const oversized = await execute(
      'project-automations-list',
      () => apiResponse({ ok: true, automations: [automation({ prompt: 'x'.repeat(2 * 1024 * 1024) })] }),
      ['prj_fixture1'],
    );
    expect(oversized.result.outcome).toBe('request_failed');

    const rejected = await execute(
      'project-automations-list',
      () => { throw new Error('fixture transport failure'); },
      ['prj_fixture1'],
    );
    expect(rejected.result.outcome).toBe('request_failed');
    expect(rejected.calls).toHaveLength(1);
  });

  test('rejects invalid positionals, ids, flags, and limits before any API request', async () => {
    const cases: Array<[string, string[], Map<string, string>]> = [
      ['project-automations-list', [], new Map()],
      ['project-automations-list', ['../private'], new Map()],
      ['project-automation-get', ['prj_fixture1'], new Map()],
      ['project-automations-status', ['prj_fixture1'], new Map([['details', 'true']])],
      ['project-automation-runs-list', ['prj_fixture1', 'aut_fixture1'], new Map([['limit', '101']])],
      ['project-automation-runs-list', ['prj_fixture1', 'aut_fixture1'], new Map([['cursor', 'private']])],
    ];
    for (const [name, positionals, flags] of cases) {
      let calls = 0;
      const pending = execute(name, () => { calls += 1; return apiResponse({}); }, positionals, flags);
      await expect(pending).rejects.toThrow();
      expect(calls).toBe(0);
    }
  });

  test('registers read commands and keeps all automation writes metadata-only and blocked', async () => {
    const help = await run(['help']);
    const commands = help.commands as Record<string, string>;
    for (const command of projectAutomationCommandDefinitions) {
      expect(commands[command.name]).toBe(command.description);
    }

    const registry = new Map(compatibilitySnapshot().capabilities.map(entry => [entry.id, entry]));
    for (const id of [
      'project.automations.list',
      'project.automations.detail',
      'project.automations.status',
      'project.automations.executions.list',
    ]) expect(registry.get(id)?.status).toBe('implemented');
    for (const id of [
      'project.automations.create',
      'project.automations.update',
      'project.automations.delete',
      'project.automations.run',
      'project.automations.enable',
      'project.automations.disable',
    ]) expect(registry.get(id)?.status).toBe('blocked');
  });
});
