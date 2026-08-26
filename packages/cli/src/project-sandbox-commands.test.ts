import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { projectSandboxCommandDefinitions } from './project-sandbox-commands';

type JsonObject = Record<string, unknown>;

const PROJECT_ID = 'proj_sandbox_fixture';

function mcpResponse(status: number, body: unknown, ok = status >= 200 && status < 300): JsonObject {
  return { content: [{ type: 'text', text: JSON.stringify({ ok, status, body }) }] };
}

function command(name: string) {
  const definition = projectSandboxCommandDefinitions.find(candidate => candidate.name === name);
  if (!definition) throw new Error(`Missing command ${name}`);
  return definition;
}

function fakeClient(response: unknown, calls: JsonObject[]): Client {
  return {
    callTool: async (request: JsonObject) => {
      calls.push(request);
      return response;
    },
  } as unknown as Client;
}

async function withPolicy<T>(work: (path: string, directory: string) => T | Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'hoplite-prebuild-policy-'));
  const path = join(directory, 'policy.json');
  const now = Date.now();
  writeFileSync(path, JSON.stringify({
    version: 1,
    owner: { accountId: 'usr_fixture', workspaceId: 'org_fixture' },
    origins: ['https://api.hoplite.sh'],
    resources: [{
      kind: 'project',
      id: PROJECT_ID,
      capabilities: ['project.prebuilds.rebake'],
      riskCeiling: 'W2',
    }],
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
  }));
  chmodSync(path, 0o600);
  try {
    return await work(path, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function planFlags(policyPath: string, outputPath: string): Map<string, string> {
  return new Map([
    ['policy', policyPath],
    ['account-id', 'usr_fixture'],
    ['workspace-id', 'org_fixture'],
    ['origin', 'https://api.hoplite.sh'],
    ['prebuild-digest', 'a'.repeat(64)],
    ['sandbox-digest', 'b'.repeat(64)],
    ['output', outputPath],
  ]);
}

function applyFlags(policyPath: string, planPath: string): Map<string, string> {
  return new Map([
    ['plan', planPath],
    ['policy', policyPath],
    ['account-id', 'usr_fixture'],
    ['workspace-id', 'org_fixture'],
    ['origin', 'https://api.hoplite.sh'],
    ['prebuild-digest', 'a'.repeat(64)],
    ['sandbox-digest', 'b'.repeat(64)],
  ]);
}

describe('project sandbox and prebuild commands', () => {
  test('reads only the public project route and projects bounded sandbox state', async () => {
    const calls: JsonObject[] = [];
    const secret = 'fixture_project_instruction_secret_never_print';
    const definition = command('project-sandbox-get');
    if (definition.transport !== 'mcp') throw new Error('Expected MCP command');
    const result = await definition.run({
      client: fakeClient(mcpResponse(200, {
        ok: true,
        project: {
          id: PROJECT_ID,
          name: 'Sandbox Fixture',
          prebuildsEnabled: true,
          sandboxSpec: {
            defaultCpu: 4,
            defaultMemoryGiB: 8,
            maxCpu: 8,
            maxMemoryGiB: 16,
            maxDiskGiB: 40,
            staffMaxCpu: null,
            staffMaxMemoryGiB: null,
            staffMaxDiskGiB: null,
            runtimeProfile: 'docker-compose',
          },
          instructions: secret,
          setupScript: `export TOKEN=${secret}`,
        },
      }), calls),
      positionals: [PROJECT_ID],
      flags: new Map(),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'hoplite_call_api',
      arguments: { method: 'GET', path: `/api/projects/${PROJECT_ID}` },
    });
    expect(result).toMatchObject({
      ok: true,
      projectId: PROJECT_ID,
      prebuildsEnabled: true,
      sandbox: {
        overrideStatus: 'project_override',
        spec: { defaultCpu: 4, defaultMemoryGiB: 8, runtimeProfile: 'docker-compose' },
      },
    });
    expect(result.stateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test('distinguishes absent and inherited sandbox overrides without inventing defaults', async () => {
    const definition = command('project-sandbox-get');
    if (definition.transport !== 'mcp') throw new Error('Expected MCP command');
    const inherited = await definition.run({
      client: fakeClient(mcpResponse(200, { ok: true, project: { id: PROJECT_ID, sandboxSpec: null } }), []),
      positionals: [PROJECT_ID],
      flags: new Map(),
    });
    expect(inherited).toMatchObject({
      prebuildsEnabled: null,
      sandbox: { fieldPresent: true, overrideStatus: 'inherits_workspace_defaults', spec: null },
    });
    const absent = await definition.run({
      client: fakeClient(mcpResponse(200, { ok: true, project: { id: PROJECT_ID } }), []),
      positionals: [PROJECT_ID],
      flags: new Map(),
    });
    expect(absent.sandbox).toEqual({ fieldPresent: false, overrideStatus: 'not_returned', spec: null });
    expect(absent.stateDigest).not.toBe(inherited.stateDigest);
  });

  test('projects at most five prebuild rows and never returns failure text or unknown fields', async () => {
    const calls: JsonObject[] = [];
    const secret = 'fixture_prebuild_failure_secret_never_print';
    const prebuilds = Array.from({ length: 7 }, (_, index) => ({
      id: `prebuild_${index}`,
      status: index === 0 ? 'baking' : index === 1 ? 'failed' : 'ready',
      repoFullName: 'fixture/example',
      commitSha: `abcdef${index}`,
      trigger: index === 0 ? 'manual' : 'base-branch',
      createdAt: `2026-08-25T12:0${index}:00.000Z`,
      promotedAt: index > 1 ? `2026-08-25T12:1${index}:00.000Z` : null,
      error: index === 1 ? `Bearer ${secret} https://private.example` : null,
      credentials: { token: secret },
    }));
    const definition = command('project-prebuilds-status');
    if (definition.transport !== 'mcp') throw new Error('Expected MCP command');
    const result = await definition.run({
      client: fakeClient(mcpResponse(200, { ok: true, prebuilds }), calls),
      positionals: [PROJECT_ID],
      flags: new Map(),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'hoplite_call_api',
      arguments: { method: 'GET', path: `/api/projects/${PROJECT_ID}/prebuilds` },
    });
    expect(result).toMatchObject({
      ok: true,
      observedCount: 7,
      returnedCount: 5,
      moreEntriesOmitted: true,
      activeCount: 1,
    });
    expect((result.prebuilds as unknown[])).toHaveLength(5);
    expect((result.prebuilds as JsonObject[])[1]).toMatchObject({
      status: 'failed',
      failureDetailPresent: true,
    });
    expect(result.stateDigest).toMatch(/^[a-f0-9]{64}$/);
    const output = JSON.stringify(result);
    expect(output).not.toContain(secret);
    expect(output).not.toContain('private.example');
    expect(output).not.toContain('credentials');
  });

  test('fails closed on schema drift, oversized rows, and strict envelope extras', async () => {
    const definition = command('project-prebuilds-status');
    if (definition.transport !== 'mcp') throw new Error('Expected MCP command');
    const fixtures = [
      mcpResponse(200, { ok: true, prebuilds: [{ id: 'bad id', status: 'ready', repoFullName: 'fixture/example', trigger: 'manual' }] }),
      mcpResponse(200, { ok: true, prebuilds: Array.from({ length: 101 }, () => ({})) }),
      { ...mcpResponse(200, { ok: true, prebuilds: [] }), structuredContent: { secret: 'private' } },
      { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 200, body: { ok: true, prebuilds: [] } }), annotations: {} }] },
    ];
    for (const fixture of fixtures) {
      await expect(definition.run({
        client: fakeClient(fixture, []),
        positionals: [PROJECT_ID],
        flags: new Map(),
      })).rejects.toThrow('schema');
    }
  });

  test('returns bounded authorization outcomes and constant transport errors without retrying', async () => {
    const definition = command('project-prebuilds-status');
    if (definition.transport !== 'mcp') throw new Error('Expected MCP command');
    const calls: JsonObject[] = [];
    const denied = await definition.run({
      client: fakeClient(mcpResponse(403, { error: 'private provider text' }, false), calls),
      positionals: [PROJECT_ID],
      flags: new Map(),
    });
    expect(calls).toHaveLength(1);
    expect(denied).toMatchObject({ ok: false, status: 403, outcome: 'role_denied', remoteStateChanged: false });
    expect(JSON.stringify(denied)).not.toContain('private provider text');

    const transportCalls: JsonObject[] = [];
    const transportClient = {
      callTool: async (request: JsonObject) => {
        transportCalls.push(request);
        throw new Error('Bearer fixture_transport_secret https://private.example');
      },
    } as unknown as Client;
    await expect(definition.run({
      client: transportClient,
      positionals: [PROJECT_ID],
      flags: new Map(),
    })).rejects.toThrow('project_sandbox_transport_error: MCP request failed before a validated response');
    expect(transportCalls).toHaveLength(1);
  });

  test('creates a <=24h owner-policy-bound local W2 plan without network access', async () => {
    await withPolicy(async (path, directory) => {
      const planPath = join(directory, 'rebake-plan.json');
      const definition = command('project-prebuilds-plan-rebake');
      if (definition.transport !== 'local') throw new Error('Expected local command');
      const result = await definition.run({
        positionals: [PROJECT_ID],
        flags: planFlags(path, planPath),
      });
      expect(result).toMatchObject({
        ok: true,
        kind: 'local_plan_file_receipt',
        capability: 'project.prebuilds.rebake',
        risk: 'W2',
        projectId: PROJECT_ID,
        state: {
          prebuildDigest: 'a'.repeat(64),
          sandboxDigest: 'b'.repeat(64),
        },
        planFileWritten: true,
        planFileMode: '0600',
        remoteApply: 'blocked',
        observedContract: { method: 'POST', requestBody: 'none' },
      });
      expect(result.planDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(statSync(planPath).mode & 0o777).toBe(0o600);
      const plan = JSON.parse(readFileSync(planPath, 'utf8')) as JsonObject;
      expect(plan).toMatchObject({
        version: 1,
        kind: 'project_prebuild_rebake_plan',
        owner: { accountId: 'usr_fixture', workspaceId: 'org_fixture' },
        origin: 'https://api.hoplite.sh',
        resource: { kind: 'project', id: PROJECT_ID },
        capability: 'project.prebuilds.rebake',
        risk: 'W2',
        policy: {
          issuedAt: expect.any(String),
          expiresAt: expect.any(String),
          grantDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        state: { prebuildDigest: 'a'.repeat(64), sandboxDigest: 'b'.repeat(64) },
      });
      expect(plan.planDigest).toBe(result.planDigest);
      const originalPlanText = readFileSync(planPath, 'utf8');
      expect(() => definition.run({
        positionals: [PROJECT_ID],
        flags: planFlags(path, planPath),
      })).toThrow();
      expect(readFileSync(planPath, 'utf8')).toBe(originalPlanText);
      expect(JSON.stringify(result)).not.toContain('usr_fixture');
      expect(JSON.stringify(result)).not.toContain('org_fixture');
      expect(JSON.stringify(result)).not.toContain('api.hoplite.sh');
    });
  });

  test('requires the exact W2 grant and current before-state digest for local planning', async () => {
    await withPolicy(async (path, directory) => {
      const definition = command('project-prebuilds-plan-rebake');
      if (definition.transport !== 'local') throw new Error('Expected local command');
      const flags = planFlags(path, join(directory, 'rebake-plan.json'));
      flags.set('account-id', 'usr_other');
      flags.set('prebuild-digest', 'not-a-digest');
      expect(() => definition.run({ positionals: [PROJECT_ID], flags })).toThrow('owner');
      flags.set('account-id', 'usr_fixture');
      expect(() => definition.run({ positionals: [PROJECT_ID], flags })).toThrow('SHA-256');
    });
  });

  test('recomputes an owner-only plan and current policy identity before the blocked apply receipt', async () => {
    await withPolicy(async (policyPath, directory) => {
      const planPath = join(directory, 'rebake-plan.json');
      const planDefinition = command('project-prebuilds-plan-rebake');
      if (planDefinition.transport !== 'local') throw new Error('Expected local plan command');
      await planDefinition.run({
        positionals: [PROJECT_ID],
        flags: planFlags(policyPath, planPath),
      });
      const definition = command('project-prebuilds-apply');
      if (definition.transport !== 'local') throw new Error('Expected local apply command');
      const result = await definition.run({
        positionals: [PROJECT_ID],
        flags: applyFlags(policyPath, planPath),
      });
      expect(result).toMatchObject({
        ok: false,
        kind: 'blocked_apply_receipt',
        projectId: PROJECT_ID,
        outcome: 'blocked',
        planFileVerified: true,
        policyGrantVerified: true,
        suppliedStateDigestsMatched: true,
        remoteRequestSent: false,
        remoteStateChanged: false,
        retryAllowed: false,
      });
      expect(result.planDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  test('rejects arbitrary digests, tampered plans, project drift, and state drift', async () => {
    await withPolicy(async (policyPath, directory) => {
      const planPath = join(directory, 'rebake-plan.json');
      const planDefinition = command('project-prebuilds-plan-rebake');
      if (planDefinition.transport !== 'local') throw new Error('Expected local plan command');
      await planDefinition.run({ positionals: [PROJECT_ID], flags: planFlags(policyPath, planPath) });
      const definition = command('project-prebuilds-apply');
      if (definition.transport !== 'local') throw new Error('Expected local apply command');

      expect(() => definition.run({
        positionals: [PROJECT_ID],
        flags: new Map([['plan-digest', 'c'.repeat(64)]]),
      })).toThrow('unsupported flags');

      const driftedState = applyFlags(policyPath, planPath);
      driftedState.set('prebuild-digest', 'd'.repeat(64));
      expect(() => definition.run({ positionals: [PROJECT_ID], flags: driftedState })).toThrow('state digests');
      expect(() => definition.run({
        positionals: ['proj_other'],
        flags: applyFlags(policyPath, planPath),
      })).toThrow('project');

      const tampered = JSON.parse(readFileSync(planPath, 'utf8')) as JsonObject;
      tampered.planDigest = 'e'.repeat(64);
      writeFileSync(planPath, JSON.stringify(tampered));
      chmodSync(planPath, 0o600);
      expect(() => definition.run({
        positionals: [PROJECT_ID],
        flags: applyFlags(policyPath, planPath),
      })).toThrow('digest does not match');
    });
  });

  test('rejects non-owner-only plan files and policy identity rotation after planning', async () => {
    await withPolicy(async (policyPath, directory) => {
      const planPath = join(directory, 'rebake-plan.json');
      const planDefinition = command('project-prebuilds-plan-rebake');
      if (planDefinition.transport !== 'local') throw new Error('Expected local plan command');
      await planDefinition.run({ positionals: [PROJECT_ID], flags: planFlags(policyPath, planPath) });
      const definition = command('project-prebuilds-apply');
      if (definition.transport !== 'local') throw new Error('Expected local apply command');

      chmodSync(planPath, 0o644);
      expect(() => definition.run({
        positionals: [PROJECT_ID],
        flags: applyFlags(policyPath, planPath),
      })).toThrow('owner-only');
      chmodSync(planPath, 0o600);

      const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as JsonObject;
      policy.expiresAt = new Date(Date.parse(String(policy.expiresAt)) + 60_000).toISOString();
      writeFileSync(policyPath, JSON.stringify(policy));
      chmodSync(policyPath, 0o600);
      expect(() => definition.run({
        positionals: [PROJECT_ID],
        flags: applyFlags(policyPath, planPath),
      })).toThrow('policy or exact grant identity no longer matches');
    });
  });

  test('rejects same-timestamp policy and exact-grant rotation after planning', async () => {
    await withPolicy(async (policyPath, directory) => {
      const planPath = join(directory, 'rebake-plan.json');
      const planDefinition = command('project-prebuilds-plan-rebake');
      if (planDefinition.transport !== 'local') throw new Error('Expected local plan command');
      await planDefinition.run({ positionals: [PROJECT_ID], flags: planFlags(policyPath, planPath) });
      const definition = command('project-prebuilds-apply');
      if (definition.transport !== 'local') throw new Error('Expected local apply command');
      const original = JSON.parse(readFileSync(policyPath, 'utf8')) as JsonObject;

      const cases: Array<{ mutate: (policy: JsonObject) => void; expected: string }> = [
        {
          mutate: policy => {
            const resources = policy.resources as JsonObject[];
            resources[0]!.riskCeiling = 'W3';
          },
          expected: 'policy or exact grant identity',
        },
        {
          mutate: policy => {
            (policy.owner as JsonObject).accountId = 'usr_rotated';
          },
          expected: 'owner',
        },
        {
          mutate: policy => {
            (policy.owner as JsonObject).workspaceId = 'org_rotated';
          },
          expected: 'owner',
        },
        {
          mutate: policy => {
            policy.origins = ['https://rotated.example'];
          },
          expected: 'origin',
        },
        {
          mutate: policy => {
            const resources = policy.resources as JsonObject[];
            resources[0]!.id = 'proj_rotated';
          },
          expected: 'resource',
        },
        {
          mutate: policy => {
            const resources = policy.resources as JsonObject[];
            resources[0]!.capabilities = ['project.update'];
          },
          expected: 'capability',
        },
        {
          mutate: policy => {
            const resources = policy.resources as JsonObject[];
            resources[0]!.riskCeiling = 'W1';
          },
          expected: 'risk',
        },
      ];

      for (const fixture of cases) {
        const rotated = JSON.parse(JSON.stringify(original)) as JsonObject;
        fixture.mutate(rotated);
        writeFileSync(policyPath, JSON.stringify(rotated));
        chmodSync(policyPath, 0o600);
        expect(() => definition.run({
          positionals: [PROJECT_ID],
          flags: applyFlags(policyPath, planPath),
        })).toThrow(fixture.expected);
      }
    });
  });
});
