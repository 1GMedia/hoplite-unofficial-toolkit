import { describe, expect, test } from 'bun:test';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  classifyReadFailure,
  parseRepositorySettingsResponse,
  projectSettingsCommandDefinitions,
} from './project-settings-commands';

type JsonObject = Record<string, unknown>;

const PROJECT_FIXTURE = {
  ok: true,
  project: {
    id: 'proj_fixture_123',
    name: 'Fixture Project',
    description: 'private fixture description',
    defaultBranch: 'main',
    previewPort: 3000,
    setupScript: 'bun install --frozen-lockfile',
    runScript: null,
    archiveScript: null,
    instructions: 'fixture instructions that require an explicit flag',
    defaultModel: 'gpt-fixture',
    reasoningEffort: 'high',
    agentSpeed: 'fast',
    prReviewAutofixDefault: false,
    sandboxSpec: { cpu: 2 },
    framework: 'fixture-framework',
    prebuildsEnabled: true,
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T01:00:00.000Z',
  },
};

const REPOSITORY_FIXTURE = {
  ok: true,
  repoSettings: {
    path: '.hoplite/settings.json',
    previewPort: 4173,
    invalid: false,
    scripts: {
      setup: { enabled: true, command: 'npm install' },
      run: { enabled: false, command: 'npm run dev' },
      archive: { enabled: true, command: 'npm run archive' },
    },
  },
};

function mcpResponse(status: number, body: unknown, ok = status >= 200 && status < 300): JsonObject {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok, status, body }) }],
  };
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
  const definition = projectSettingsCommandDefinitions.find(candidate => candidate.name === name);
  if (!definition || definition.transport !== 'mcp') throw new Error(`Missing MCP command ${name}`);
  return definition;
}

describe('project settings read commands', () => {
  test('returns a safe default projection without descriptions, commands, or instructions', async () => {
    const result = await command('project-settings-get').run({
      client: fakeClient(path => {
        expect(path).toBe('/api/projects/proj_fixture_123');
        return mcpResponse(200, PROJECT_FIXTURE);
      }),
      positionals: ['proj_fixture_123'],
      flags: new Map(),
    });

    expect(result.ok).toBe(true);
    expect(result.availability).toBe('confirmed_for_current_credential');
    expect(JSON.stringify(result)).not.toContain('private fixture description');
    expect(JSON.stringify(result)).not.toContain('bun install --frozen-lockfile');
    expect(JSON.stringify(result)).not.toContain('fixture instructions that require');
    expect(result.project).toMatchObject({
      id: 'proj_fixture_123',
      descriptionConfigured: true,
      previewPort: 3000,
      sandboxConfigured: true,
    });
  });

  test('only emits bounded command and instruction values behind explicit flags', async () => {
    const longProject = structuredClone(PROJECT_FIXTURE);
    longProject.project.setupScript = 'x'.repeat(2_100);
    longProject.project.instructions = 'y'.repeat(8_100);
    const result = await command('project-settings-get').run({
      client: fakeClient(() => mcpResponse(200, longProject)),
      positionals: ['proj_fixture_123'],
      flags: new Map([
        ['show-commands', 'true'],
        ['include-instructions', 'yes'],
      ]),
    });

    const project = result.project as JsonObject;
    const commands = project.commands as JsonObject;
    const setup = commands.setup as JsonObject;
    const commandValue = setup.command as JsonObject;
    const instructions = project.instructions as JsonObject;
    const content = instructions.content as JsonObject;
    expect((commandValue.value as string).length).toBe(2_000);
    expect(commandValue.truncated).toBe(true);
    expect((content.value as string).length).toBe(8_000);
    expect(content.truncated).toBe(true);
    expect(commandValue.originalLength).toBeUndefined();
    expect(content.originalLength).toBeUndefined();
  });

  test('redacts credential-shaped text and bounds every server-derived string', async () => {
    const sensitiveProject = structuredClone(PROJECT_FIXTURE);
    sensitiveProject.project.name = `${'N'.repeat(900)} API_KEY=fixture-api-key-should-not-print`;
    sensitiveProject.project.defaultBranch = 'Authorization: Bearer fixture-bearer-token-should-not-print';
    sensitiveProject.project.framework = 'https://user:password@example.test/private?token=fixture-url-token';
    sensitiveProject.project.defaultModel = 'model secret=fixture-model-secret-should-not-print';
    sensitiveProject.project.setupScript = 'API_KEY=fixture-command-key Authorization: Bearer fixture-command-bearer {"apiKey":"fixture-command-json-key"}';
    sensitiveProject.project.instructions = 'Open https://user:pass@example.test/credential?api_key=fixture-instruction-key {"authorization":"Bearer fixture-instruction-json-bearer","credential":"https://example.test/private"}';
    const sensitiveRepository = structuredClone(REPOSITORY_FIXTURE);
    sensitiveRepository.repoSettings.path = 'https://user:pass@example.test/repo?token=fixture-repo-token';
    sensitiveRepository.repoSettings.scripts.archive.command = 'Authorization=Bearer fixture-repo-bearer';

    const result = await command('project-settings-resolve').run({
      client: fakeClient(path => path.endsWith('/repo-settings')
        ? mcpResponse(200, sensitiveRepository)
        : mcpResponse(200, sensitiveProject)),
      positionals: ['proj_fixture_123'],
      flags: new Map([
        ['show-commands', 'true'],
        ['include-instructions', 'true'],
      ]),
    });

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'fixture-api-key-should-not-print',
      'fixture-bearer-token-should-not-print',
      'fixture-url-token',
      'fixture-model-secret-should-not-print',
      'fixture-command-key',
      'fixture-command-bearer',
      'fixture-command-json-key',
      'fixture-instruction-key',
      'fixture-instruction-json-bearer',
      'fixture-repo-token',
      'fixture-repo-bearer',
      'example.test',
    ]) expect(serialized).not.toContain(forbidden);
    expect(serialized).toContain('[redacted]');
    expect(serialized).toContain('[url]');
    const project = result.project as JsonObject;
    expect((project.name as string).length).toBe(512);
    expect(serialized).not.toContain('originalLength');
  });

  test('applies field-specific bounds to oversized non-sensitive settings', async () => {
    const oversizedProject = structuredClone(PROJECT_FIXTURE);
    oversizedProject.project.name = 'n'.repeat(900);
    oversizedProject.project.defaultBranch = 'b'.repeat(900);
    oversizedProject.project.framework = 'f'.repeat(900);
    oversizedProject.project.defaultModel = 'm'.repeat(1_500);
    const oversizedRepository = structuredClone(REPOSITORY_FIXTURE);
    oversizedRepository.repoSettings.path = 'p'.repeat(1_500);

    const result = await command('project-settings-resolve').run({
      client: fakeClient(path => path.endsWith('/repo-settings')
        ? mcpResponse(200, oversizedRepository)
        : mcpResponse(200, oversizedProject)),
      positionals: ['proj_fixture_123'],
      flags: new Map(),
    });

    const project = result.project as JsonObject;
    const agents = project.agents as JsonObject;
    const repository = result.repository as JsonObject;
    const path = repository.path as JsonObject;
    expect((project.name as string).length).toBe(512);
    expect((project.defaultBranch as string).length).toBe(512);
    expect((project.framework as string).length).toBe(512);
    expect((agents.defaultModel as string).length).toBe(1_024);
    expect((path.value as string).length).toBe(1_024);
    expect(path.truncated).toBe(true);
  });

  test('resolves project overrides, repository disabled state, and enabled repository commands', async () => {
    const paths: string[] = [];
    const result = await command('project-settings-resolve').run({
      client: fakeClient(path => {
        paths.push(path);
        return path.endsWith('/repo-settings')
          ? mcpResponse(200, REPOSITORY_FIXTURE)
          : mcpResponse(200, PROJECT_FIXTURE);
      }),
      positionals: ['proj_fixture_123'],
      flags: new Map([['show-commands', 'true']]),
    });

    expect(paths).toEqual([
      '/api/projects/proj_fixture_123',
      '/api/projects/proj_fixture_123/repo-settings',
    ]);
    const effective = result.effective as JsonObject;
    expect(effective.commands).toMatchObject({
      setup: { state: 'enabled', source: 'project' },
      run: { state: 'disabled', source: 'repository' },
      archive: { state: 'enabled', source: 'repository' },
    });
    expect(JSON.stringify(result)).toContain('bun install --frozen-lockfile');
    expect(JSON.stringify(result)).toContain('npm run archive');
    expect(JSON.stringify(result)).not.toContain('npm run dev');
  });

  test('ignores invalid repository settings with a warning', async () => {
    const invalidRepository = structuredClone(REPOSITORY_FIXTURE);
    invalidRepository.repoSettings.invalid = true;
    const result = await command('project-settings-resolve').run({
      client: fakeClient(path => path.endsWith('/repo-settings')
        ? mcpResponse(200, invalidRepository)
        : mcpResponse(200, PROJECT_FIXTURE)),
      positionals: ['proj_fixture_123'],
      flags: new Map(),
    });

    const effective = result.effective as JsonObject;
    expect(effective.commands).toMatchObject({
      setup: { state: 'enabled', source: 'project' },
      run: { state: 'unset', source: 'none' },
      archive: { state: 'unset', source: 'none' },
    });
    expect(result.warnings).toEqual(['Repository settings are marked invalid and were ignored.']);
  });

  test('treats a missing repository surface as partial without claiming availability', async () => {
    const result = await command('project-settings-resolve').run({
      client: fakeClient(path => path.endsWith('/repo-settings')
        ? mcpResponse(404, { ok: false }, false)
        : mcpResponse(200, PROJECT_FIXTURE)),
      positionals: ['proj_fixture_123'],
      flags: new Map(),
    });

    expect(result.ok).toBe(true);
    expect(result.availability).toBe('partial');
    expect(result.repository).toMatchObject({
      ok: false,
      status: 404,
      outcome: 'repository_settings_absent',
      availability: 'unknown',
    });
  });

  test('distinguishes credential, role, absence, and schema drift outcomes', async () => {
    expect(classifyReadFailure(401, 'project')).toMatchObject({ outcome: 'unsupported_credential', availability: 'unknown' });
    expect(classifyReadFailure(403, 'project')).toMatchObject({ outcome: 'role_denied', availability: 'unknown' });
    expect(classifyReadFailure(404, 'project')).toMatchObject({ outcome: 'project_absent', availability: 'unknown' });

    const drift = await command('project-settings-get').run({
      client: fakeClient(() => mcpResponse(200, { ok: true, project: { id: 'proj_fixture_123' } })),
      positionals: ['proj_fixture_123'],
      flags: new Map(),
    });
    expect(drift).toMatchObject({
      ok: false,
      status: 200,
      outcome: 'schema_drift',
      availability: 'unknown',
    });
  });

  test('parses wrapped and bare repository compatibility fixtures strictly', () => {
    const wrapped = parseRepositorySettingsResponse(REPOSITORY_FIXTURE);
    const bare = parseRepositorySettingsResponse(REPOSITORY_FIXTURE.repoSettings);
    expect(wrapped).toEqual(bare);
    expect(() => parseRepositorySettingsResponse({
      ...REPOSITORY_FIXTURE.repoSettings,
      scripts: { setup: { enabled: 'yes', command: null } },
    })).toThrow('schema drift');
  });
});
