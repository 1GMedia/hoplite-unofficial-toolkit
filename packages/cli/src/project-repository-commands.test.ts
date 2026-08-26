import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { projectRepositoryCommandDefinitions } from './project-repository-commands';

type JsonObject = Record<string, unknown>;

const PROJECT_ID = 'proj_repository_fixture';
const PROJECT_FIXTURE = {
  ok: true,
  project: {
    id: PROJECT_ID,
    name: 'Repository Fixture',
    previewPort: 3000,
    repos: [{ repoFullName: 'fixture/example', branch: 'release/next' }],
  },
};
const UNBOUND_PROJECT_FIXTURE = {
  ok: true,
  project: {
    id: PROJECT_ID,
    name: 'Unbound Repository Fixture',
    previewPort: 3000,
    repos: [],
  },
};
const CATALOG_FIXTURE = {
  ok: true,
  repositories: [{
    id: 'repo_fixture_123',
    fullName: 'fixture/example',
    defaultBranch: 'main',
    private: true,
  }],
};
const SETTINGS_FIXTURE = {
  ok: true,
  repoSettings: {
    path: '.hoplite/settings.json',
    invalid: false,
    previewPort: 4173,
    scripts: {
      setup: { enabled: true, command: 'bun install' },
      run: { enabled: false, command: 'bun run dev' },
      archive: { enabled: true, command: null },
    },
  },
};

function mcpResponse(status: number, body: unknown, ok = status >= 200 && status < 300): JsonObject {
  return { content: [{ type: 'text', text: JSON.stringify({ ok, status, body }) }] };
}

function fakeClient(handler: (path: string) => JsonObject): Client {
  return {
    callTool: async (request: { arguments?: JsonObject }) => {
      const args = request.arguments ?? {};
      expect(args.method).toBe('GET');
      return handler(String(args.path));
    },
  } as unknown as Client;
}

function command(name: string) {
  const definition = projectRepositoryCommandDefinitions.find(candidate => candidate.name === name);
  if (!definition) throw new Error(`Missing command ${name}`);
  return definition;
}

function withPolicy<T>(work: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'hoplite-repository-policy-'));
  const path = join(directory, 'policy.json');
  const now = Date.now();
  writeFileSync(path, JSON.stringify({
    version: 1,
    owner: { accountId: 'usr_fixture', workspaceId: 'org_fixture' },
    origins: ['https://app.hoplite.sh'],
    resources: [{
      kind: 'project',
      id: PROJECT_ID,
      capabilities: ['project.repository.bind', 'project.repository.unbind'],
      riskCeiling: 'W2',
    }],
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
  }));
  chmodSync(path, 0o600);
  try {
    return work(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function planFlags(policyPath: string): Map<string, string> {
  return new Map([
    ['policy', policyPath],
    ['account-id', 'usr_fixture'],
    ['workspace-id', 'org_fixture'],
    ['origin', 'https://app.hoplite.sh'],
    ['before-digest', 'a'.repeat(64)],
    ['client-operation-id', 'repository-plan-fixture-001'],
  ]);
}

describe('project repository commands', () => {
  test('reads a bounded binding and deterministic before-state digest', async () => {
    const definition = command('project-repository-get');
    expect(definition.transport).toBe('mcp');
    if (definition.transport !== 'mcp') throw new Error('Expected MCP command');
    const result = await definition.run({
      client: fakeClient(path => {
        expect(path).toBe(`/api/projects/${PROJECT_ID}`);
        return mcpResponse(200, PROJECT_FIXTURE);
      }),
      positionals: [PROJECT_ID],
      flags: new Map(),
    });
    const binding = result.binding as JsonObject;
    expect(binding).toMatchObject({
      projectId: PROJECT_ID,
      bound: true,
      bindingCount: 1,
      selected: { fullName: 'fixture/example', branch: 'release/next' },
    });
    expect(binding.stateDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test('resolves the saved binding without exposing repository commands', async () => {
    const definition = command('project-repository-resolve');
    if (definition.transport !== 'mcp') throw new Error('Expected MCP command');
    const paths: string[] = [];
    const result = await definition.run({
      client: fakeClient(path => {
        paths.push(path);
        if (path === `/api/projects/${PROJECT_ID}`) return mcpResponse(200, PROJECT_FIXTURE);
        if (path === '/api/source-control/github/repositories') return mcpResponse(200, CATALOG_FIXTURE);
        if (path.endsWith('/repo-settings')) return mcpResponse(200, SETTINGS_FIXTURE);
        throw new Error(`Unexpected path ${path}`);
      }),
      positionals: [PROJECT_ID],
      flags: new Map(),
    });
    expect(paths).toEqual([
      `/api/projects/${PROJECT_ID}`,
      '/api/source-control/github/repositories',
      `/api/projects/${PROJECT_ID}/repo-settings`,
    ]);
    expect(result.repository).toMatchObject({
      resolved: true,
      id: 'repo_fixture_123',
      fullName: 'fixture/example',
      private: true,
      defaultBranch: 'main',
    });
    expect(result.effectiveBaseBranch).toEqual({ value: 'release/next', source: 'project-binding' });
    expect(result.previewPrecedence).toBe('not_resolved');
    expect(JSON.stringify(result)).not.toContain('bun install');
    expect(JSON.stringify(result)).not.toContain('bun run dev');
  });

  test('keeps repo-settings credential and role failures partial and explicit', async () => {
    const definition = command('project-repository-resolve');
    if (definition.transport !== 'mcp') throw new Error('Expected MCP command');
    const result = await definition.run({
      client: fakeClient(path => {
        if (path === `/api/projects/${PROJECT_ID}`) return mcpResponse(200, PROJECT_FIXTURE);
        if (path === '/api/source-control/github/repositories') return mcpResponse(200, CATALOG_FIXTURE);
        return mcpResponse(403, { ok: false }, false);
      }),
      positionals: [PROJECT_ID],
      flags: new Map(),
    });
    expect(result.availability).toBe('partial');
    expect(result.repositorySettings).toMatchObject({
      ok: false,
      status: 403,
      outcome: 'role_denied',
      availability: 'unknown',
    });
  });

  test('reports a confirmed unbound project without requesting repo-settings', async () => {
    const definition = command('project-repository-resolve');
    if (definition.transport !== 'mcp') throw new Error('Expected MCP command');
    const paths: string[] = [];
    const result = await definition.run({
      client: fakeClient(path => {
        paths.push(path);
        if (path === `/api/projects/${PROJECT_ID}`) return mcpResponse(200, UNBOUND_PROJECT_FIXTURE);
        if (path === '/api/source-control/github/repositories') return mcpResponse(200, CATALOG_FIXTURE);
        throw new Error(`Unexpected path ${path}`);
      }),
      positionals: [PROJECT_ID],
      flags: new Map(),
    });
    expect(paths).toEqual([
      `/api/projects/${PROJECT_ID}`,
      '/api/source-control/github/repositories',
    ]);
    expect(result.repositorySettings).toEqual({ availability: 'not_applicable' });
    expect(result.availability).toBe('confirmed_for_current_credential');
  });

  test('creates a policy-bound local bind plan without authorizing remote apply', async () => {
    await withPolicy(async path => {
      const definition = command('project-repository-plan-bind');
      expect(definition.transport).toBe('local');
      if (definition.transport !== 'local') throw new Error('Expected local command');
      const flags = planFlags(path);
      flags.set('repository-id', 'repo_fixture_123');
      flags.set('repository-full-name', 'fixture/example');
      flags.set('default-branch', 'main');
      flags.set('base-branch', 'release/next');
      const result = await definition.run({ positionals: [PROJECT_ID], flags });
      expect(result).toMatchObject({
        ok: true,
        kind: 'local_plan',
        capability: 'project.repository.bind',
        risk: 'W2',
        remoteApply: 'blocked',
        intent: {
          projectId: PROJECT_ID,
          repositoryId: 'repo_fixture_123',
          repositoryFullName: 'fixture/example',
          baseBranch: 'release/next',
          defaultBranch: 'main',
        },
      });
      expect(result.planDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(result)).not.toContain('app.hoplite.sh');
    });
  });

  test('requires exactly one explicit base-branch choice in a bind plan', async () => {
    await withPolicy(async path => {
      const definition = command('project-repository-plan-bind');
      if (definition.transport !== 'local') throw new Error('Expected local command');
      const flags = planFlags(path);
      flags.set('repository-id', 'repo_fixture_123');
      flags.set('repository-full-name', 'fixture/example');
      flags.set('default-branch', 'main');
      expect(() => definition.run({ positionals: [PROJECT_ID], flags })).toThrow('exactly one');
      flags.set('base-branch', 'main');
      flags.set('inherit-default', 'true');
      expect(() => definition.run({ positionals: [PROJECT_ID], flags })).toThrow('exactly one');
    });
  });

  test('creates an unbind review plan while leaving payload semantics blocked', async () => {
    await withPolicy(async path => {
      const definition = command('project-repository-plan-unbind');
      if (definition.transport !== 'local') throw new Error('Expected local command');
      const result = await definition.run({
        positionals: [PROJECT_ID],
        flags: planFlags(path),
      });
      expect(result).toMatchObject({
        capability: 'project.repository.unbind',
        risk: 'W2',
        remoteApply: 'blocked',
        evidenceBoundary: {
          sourceTier: 'local-inference',
          remoteContract: 'not_observed',
          scope: 'local_policy_bound_plan_only',
        },
      });
      expect(result).not.toHaveProperty('observedContract');
      expect(JSON.stringify(result)).not.toContain('PATCH');
      expect(JSON.stringify(result)).not.toContain('/api/projects/:projectId');
    });
  });

  test('keeps apply local and permanently non-mutating for the current evidence', async () => {
    const definition = command('project-repository-apply');
    expect(definition.transport).toBe('local');
    if (definition.transport !== 'local') throw new Error('Expected local command');
    const result = await definition.run({ positionals: [], flags: new Map([['confirm', 'true']]) });
    expect(result).toMatchObject({
      ok: false,
      outcome: 'blocked',
      remoteStateChanged: false,
    });
  });
});
