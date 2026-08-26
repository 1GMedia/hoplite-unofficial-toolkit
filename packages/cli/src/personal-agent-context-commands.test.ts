import { describe, expect, test } from 'bun:test';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { personalAgentContextCommandDefinitions } from './personal-agent-context-commands';

type JsonObject = Record<string, unknown>;

const MEMORY_FIXTURE = {
  ok: true,
  memories: [{
    id: 'mem_fixture_personal',
    content: 'Use concise output. password="fixture secret multi word" API_KEY=\'fixture shell secret\' https://private.example/path',
    scope: 'personal',
  }],
};

const SKILL_FIXTURE = {
  ok: true,
  skills: [{
    id: 'skill_fixture_one',
    name: 'fixture-skill',
    description: 'Fixture helper for https://private.example/docs',
    body: 'Authorization="Bearer fixture token multi word"\nFollow the fixture workflow.',
    source: 'imported',
    sourceLabel: 'Fixture import',
  }],
};

function mcpResponse(status: number, body: unknown, ok = status >= 200 && status < 300): JsonObject {
  return { isError: false, content: [{ type: 'text', text: JSON.stringify({ ok, status, body }) }] };
}

function fakeClient(handler: (request: JsonObject) => JsonObject | Promise<JsonObject>): Client {
  return {
    callTool: async (request: { arguments?: JsonObject }) => handler(request.arguments ?? {}),
  } as unknown as Client;
}

function command(name: string) {
  const definition = personalAgentContextCommandDefinitions.find(candidate => candidate.name === name);
  if (!definition) throw new Error(`Missing command ${name}`);
  if (definition.transport !== 'mcp') throw new Error('Expected MCP command');
  return definition;
}

describe('personal agent context commands', () => {
  test('lists aggregate-only memory inventory with one GET', async () => {
    const calls: JsonObject[] = [];
    const result = await command('personal-memories-list').run({
      client: fakeClient(request => {
        calls.push(request);
        return mcpResponse(200, MEMORY_FIXTURE);
      }),
      positionals: [],
      flags: new Map(),
    });
    expect(calls).toEqual([{ method: 'GET', path: '/api/agent-memories' }]);
    expect(result).toMatchObject({
      ok: true,
      availability: 'confirmed_for_current_credential',
      inventoryPolicy: 'aggregate_only',
      privacyPolicy: 'no_ids_text_digests_or_lengths',
      totalCount: 1,
      contentPresentCount: 1,
      contentEmptyCount: 0,
      scopeCounts: { personal: 1, organization: 0, project: 0, thread: 0 },
    });
    expect(result.memories).toBeUndefined();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(MEMORY_FIXTURE.memories[0]!.id);
    expect(serialized).not.toContain(MEMORY_FIXTURE.memories[0]!.content);
    expect(serialized).not.toContain('private.example');
    expect(serialized).not.toContain('sha256');
    expect(serialized).not.toContain('byteLength');
  });

  test('lists aggregate-only skill inventory with one GET', async () => {
    const calls: JsonObject[] = [];
    const result = await command('personal-skills-list').run({
      client: fakeClient(request => {
        calls.push(request);
        return mcpResponse(200, SKILL_FIXTURE);
      }),
      positionals: [],
      flags: new Map(),
    });
    expect(calls).toEqual([{ method: 'GET', path: '/api/user/skills' }]);
    expect(result).toMatchObject({
      ok: true,
      inventoryPolicy: 'aggregate_only',
      privacyPolicy: 'no_ids_text_digests_or_lengths',
      totalCount: 1,
      bodyPresentCount: 1,
      bodyEmptyCount: 0,
      sourceCounts: { custom: 0, imported: 1 },
    });
    expect(result.skills).toBeUndefined();
    const serialized = JSON.stringify(result);
    for (const value of Object.values(SKILL_FIXTURE.skills[0]!)) {
      if (typeof value === 'string' && value !== 'imported') expect(serialized).not.toContain(value);
    }
    expect(serialized).not.toContain('sha256');
    expect(serialized).not.toContain('byteLength');
  });

  test('never emits freeform fields even when every field contains credentials', async () => {
    const memorySecrets = ['fixture memory id secret words', 'fixture memory content secret words'];
    const memoryResult = await command('personal-memories-list').run({
      client: fakeClient(() => mcpResponse(200, {
        ok: true,
        memories: [{
          id: `mem authToken=${memorySecrets[0]}`,
          content: `STRIPE_KEY=${memorySecrets[1]}`,
          scope: 'personal',
        }],
      })),
      positionals: [],
      flags: new Map(),
    });
    const skillSecrets = [
      'fixture skill id secret words',
      'fixture skill name secret words',
      'fixture skill description secret words',
      'fixture skill source label secret words',
      'fixture skill body secret words',
    ];
    const skillResult = await command('personal-skills-list').run({
      client: fakeClient(() => mcpResponse(200, {
        ok: true,
        skills: [{
          id: `skill tenantCredentialLabel=${skillSecrets[0]}`,
          name: `name PREFIX_AUTH_TOKEN=${skillSecrets[1]}`,
          description: `CUSTOM_PROVIDER_KEY=${skillSecrets[2]}`,
          source: 'custom',
          sourceLabel: `clientSecret=${skillSecrets[3]}`,
          body: `Authorization=Bearer ${skillSecrets[4]}`,
        }],
      })),
      positionals: [],
      flags: new Map(),
    });
    const serialized = JSON.stringify({ memoryResult, skillResult });
    for (const secret of [...memorySecrets, ...skillSecrets]) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('authToken');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('sha256');
    expect(serialized).not.toContain('byteLength');
    expect(memoryResult).toMatchObject({ totalCount: 1, contentPresentCount: 1 });
    expect(skillResult).toMatchObject({ totalCount: 1, bodyPresentCount: 1 });
  });

  test('counts empty content and bodies without exposing individual rows', async () => {
    const memoryResult = await command('personal-memories-list').run({
      client: fakeClient(() => mcpResponse(200, {
        ok: true,
        memories: [
          { id: 'mémoire', content: 'é', scope: 'personal' },
          { id: 'hidden', content: '', scope: 'thread' },
        ],
      })),
      positionals: [],
      flags: new Map(),
    });
    expect(memoryResult).toMatchObject({
      totalCount: 2,
      contentPresentCount: 1,
      contentEmptyCount: 1,
      scopeCounts: { personal: 1, organization: 0, project: 0, thread: 1 },
    });

    const skillResult = await command('personal-skills-list').run({
      client: fakeClient(() => mcpResponse(200, {
        ok: true,
        skills: [{
          id: 'skill_blank',
          name: 'blank',
          description: 'Blank skill fixture',
          body: '',
          source: 'custom',
          sourceLabel: null,
        }],
      })),
      positionals: [],
      flags: new Map(),
    });
    expect(skillResult).toMatchObject({
      totalCount: 1,
      bodyPresentCount: 0,
      bodyEmptyCount: 1,
      sourceCounts: { custom: 1, imported: 0 },
    });
    expect(memoryResult.memories).toBeUndefined();
    expect(skillResult.skills).toBeUndefined();
  });

  test('keeps identifiers and skill metadata non-empty', async () => {
    const invalidBodies = [
      { ok: true, memories: [{ id: '', content: '', scope: 'personal' }] },
      { ok: true, memories: [{ id: ' \t\n', content: '', scope: 'personal' }] },
      { ok: true, memories: [{ id: 'mem_fixture', content: '', scope: '' }] },
      { ok: true, skills: [{ id: '', name: 'name', description: 'description', body: '', source: 'custom' }] },
      { ok: true, skills: [{ id: ' \t\n', name: 'name', description: 'description', body: '', source: 'custom' }] },
      { ok: true, skills: [{ id: 'skill_fixture', name: '', description: 'description', body: '', source: 'custom' }] },
      { ok: true, skills: [{ id: 'skill_fixture', name: ' \t\n', description: 'description', body: '', source: 'custom' }] },
      { ok: true, skills: [{ id: 'skill_fixture', name: 'name', description: '', body: '', source: 'custom' }] },
      { ok: true, skills: [{ id: 'skill_fixture', name: 'name', description: ' \t\n', body: '', source: 'custom' }] },
      { ok: true, skills: [{ id: 'skill_fixture', name: 'name', description: 'description', body: '', source: '' }] },
    ];
    for (const body of invalidBodies) {
      const name = 'memories' in body ? 'personal-memories-list' : 'personal-skills-list';
      const result = await command(name).run({
        client: fakeClient(() => mcpResponse(200, body)),
        positionals: [],
        flags: new Map(),
      });
      expect(result).toMatchObject({ ok: false, status: 200, outcome: 'schema_drift' });
    }
  });

  test('counts the complete bounded response without invented server query semantics', async () => {
    const result = await command('personal-memories-list').run({
      client: fakeClient(() => mcpResponse(200, {
        ok: true,
        memories: [
          { id: 'mem_one', content: 'one', scope: 'personal' },
          { id: 'mem_two', content: 'two', scope: 'organization' },
        ],
      })),
      positionals: [],
      flags: new Map(),
    });
    expect(result).toMatchObject({
      totalCount: 2,
      contentPresentCount: 2,
      scopeCounts: { personal: 1, organization: 1, project: 0, thread: 0 },
    });
  });

  test('distinguishes current-credential, role, and current-principal absence outcomes', async () => {
    const cases = [
      [401, 'unsupported_credential'],
      [403, 'role_denied'],
      [404, 'memories_absent_for_current_principal'],
    ] as const;
    for (const [status, outcome] of cases) {
      let calls = 0;
      const result = await command('personal-memories-list').run({
        client: fakeClient(() => {
          calls += 1;
          return mcpResponse(status, { ok: false }, false);
        }),
        positionals: [],
        flags: new Map(),
      });
      expect(calls).toBe(1);
      expect(result).toMatchObject({ ok: false, status, outcome, availability: 'unknown' });
    }
    const skill404 = await command('personal-skills-list').run({
      client: fakeClient(() => mcpResponse(404, { ok: false }, false)),
      positionals: [],
      flags: new Map(),
    });
    expect(skill404.outcome).toBe('skills_absent_for_current_principal');
  });

  test('fails closed on body and MCP envelope schema drift', async () => {
    const invalidBody = await command('personal-memories-list').run({
      client: fakeClient(() => mcpResponse(200, {
        ok: true,
        memories: [{ id: 'mem_bad', content: 'fixture', scope: 'unexpected' }],
      })),
      positionals: [],
      flags: new Map(),
    });
    expect(invalidBody).toMatchObject({ outcome: 'schema_drift', surface: 'agent-memories' });

    const invalidEnvelope = await command('personal-skills-list').run({
      client: fakeClient(() => ({ isError: false, content: [{ type: 'text', text: '{not-json' }] })),
      positionals: [],
      flags: new Map(),
    });
    expect(invalidEnvelope).toMatchObject({ outcome: 'schema_drift', surface: 'personal-skills', status: 0 });
  });

  test('requires an own boolean false isError field', async () => {
    const validText = JSON.stringify({ ok: true, status: 200, body: MEMORY_FIXTURE });
    const fixtures: JsonObject[] = [
      { content: [{ type: 'text', text: validText }] },
      Object.assign(Object.create({ isError: false }), { content: [{ type: 'text', text: validText }] }),
      { isError: 'false', content: [{ type: 'text', text: validText }] },
      { isError: true, content: [{ type: 'text', text: validText }] },
    ];
    for (const fixture of fixtures) {
      const result = await command('personal-memories-list').run({
        client: fakeClient(() => fixture),
        positionals: [],
        flags: new Map(),
      });
      expect(result).toMatchObject({
        ok: false,
        status: 0,
        outcome: 'schema_drift',
        surface: 'agent-memories',
      });
    }
  });

  test('rejects extra content or fields and inconsistent embedded success', async () => {
    const validText = JSON.stringify({ ok: true, status: 200, body: MEMORY_FIXTURE });
    const fixtures: JsonObject[] = [
      Object.assign(Object.create({ content: [{ type: 'text', text: validText }] }), { isError: false }),
      { isError: false, content: [{ type: 'text', text: validText }], structuredContent: {} },
      { isError: false, content: [{ type: 'text', text: validText }, { type: 'text', text: validText }] },
      { isError: false, content: [Object.create({ type: 'text', text: validText })] },
      { isError: false, content: [Object.assign(Object.create({ type: 'text' }), { text: validText })] },
      { isError: false, content: [Object.assign(Object.create({ text: validText }), { type: 'text' })] },
      { isError: false, content: [{ type: 'text', text: validText, annotations: {} }] },
      { isError: false, content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 200, body: MEMORY_FIXTURE, extra: true }) }] },
      { isError: false, content: [{ type: 'text', text: '{"__proto__":{"ok":true,"status":200,"body":{}}}' }] },
      { isError: false, content: [{ type: 'text', text: JSON.stringify({ status: 200, body: MEMORY_FIXTURE }) }] },
      { isError: false, content: [{ type: 'text', text: JSON.stringify({ ok: true, body: MEMORY_FIXTURE }) }] },
      { isError: false, content: [{ type: 'text', text: JSON.stringify({ ok: false, status: 200, body: MEMORY_FIXTURE }) }] },
      { isError: false, content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 403, body: { ok: false } }) }] },
      { isError: false, content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 200 }) }] },
    ];
    for (const fixture of fixtures) {
      let calls = 0;
      const result = await command('personal-memories-list').run({
        client: fakeClient(() => {
          calls += 1;
          return fixture;
        }),
        positionals: [],
        flags: new Map(),
      });
      expect(calls).toBe(1);
      expect(result).toMatchObject({
        ok: false,
        status: 0,
        outcome: 'schema_drift',
        surface: 'agent-memories',
      });
    }
  });

  test('rejects oversized MCP text before JSON parsing', async () => {
    let calls = 0;
    const result = await command('personal-skills-list').run({
      client: fakeClient(() => {
        calls += 1;
        // Fewer than 2 MiB characters but more than 2 MiB of UTF-8 proves the
        // ceiling is byte-based and runs before the invalid JSON is parsed.
        return { isError: false, content: [{ type: 'text', text: 'é'.repeat(1024 * 1024 + 1) }] };
      }),
      positionals: [],
      flags: new Map(),
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      status: 0,
      outcome: 'schema_drift',
      surface: 'personal-skills',
    });
    expect(String(result.message)).toContain('exceeded');
  });

  test('rejects more than the strict maximum response rows before counting', async () => {
    const memories = Array.from({ length: 101 }, (_value, index) => (
      index === 100
        ? { invalid: true }
        : { id: `mem_${index}`, content: 'fixture', scope: 'personal' }
    ));
    const result = await command('personal-memories-list').run({
      client: fakeClient(() => mcpResponse(200, { ok: true, memories })),
      positionals: [],
      flags: new Map(),
    });
    expect(result).toMatchObject({ outcome: 'schema_drift', surface: 'agent-memories' });
    expect(String(result.message)).toContain('more than 100 rows');
    expect(String(result.message)).not.toContain('memories[100]');
  });

  test('returns one constant secret-free transport error without retrying', async () => {
    for (const name of ['personal-memories-list', 'personal-skills-list']) {
      let calls = 0;
      const result = await command(name).run({
        client: fakeClient(() => {
          calls += 1;
          throw new Error('password="fixture transport secret with spaces"');
        }),
        positionals: [],
        flags: new Map(),
      });
      expect(calls).toBe(1);
      expect(result).toEqual({
        ok: false,
        status: 0,
        outcome: 'transport_error',
        surface: name === 'personal-memories-list' ? 'agent-memories' : 'personal-skills',
        availability: 'unknown',
        message: 'The personal-context read could not be completed through the current MCP transport; no availability conclusion was made.',
      });
      expect(JSON.stringify(result)).not.toContain('fixture transport secret');
    }
  });

  test('rejects all positionals and unsupported flags before transport', async () => {
    for (const [name, unsupportedFlag] of [
      ['personal-memories-list', 'include-content'],
      ['personal-memories-list', 'include-body'],
      ['personal-memories-list', 'limit'],
      ['personal-skills-list', 'include-content'],
      ['personal-skills-list', 'include-body'],
      ['personal-skills-list', 'limit'],
    ] as const) {
      let calls = 0;
      const client = fakeClient(() => {
        calls += 1;
        return mcpResponse(200, name === 'personal-memories-list' ? MEMORY_FIXTURE : SKILL_FIXTURE);
      });
      await expect(command(name).run({
        client,
        positionals: ['unexpected'],
        flags: new Map(),
      })).rejects.toThrow('does not accept positional arguments');
      await expect(command(name).run({
        client,
        positionals: [],
        flags: new Map([[unsupportedFlag, 'true']]),
      })).rejects.toThrow(`does not support --${unsupportedFlag}`);
      await expect(command(name).run({
        client,
        positionals: [],
        flags: new Map([['unknown', 'true']]),
      })).rejects.toThrow('does not support --unknown');
      expect(calls).toBe(0);
    }
  });

  test('registers no mutation or apply command in this evidence tier', () => {
    expect(personalAgentContextCommandDefinitions.map(definition => definition.name)).toEqual([
      'personal-memories-list',
      'personal-skills-list',
    ]);
    expect(personalAgentContextCommandDefinitions.every(definition => definition.transport === 'mcp')).toBe(true);
  });
});
