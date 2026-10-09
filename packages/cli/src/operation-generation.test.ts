import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { collectOperations, generateOutputs, qualifyEmbeddedDefinitions, validateSpec, writeOutputs } from '../../../scripts/generate-operations';

function fixture() {
  return {
    openapi: '3.1.0', info: { title: 'Fixture only', version: '1' },
    paths: {
      '/api/fixture/{id}': {
        parameters: [{ $ref: '#/components/parameters/Key' }],
        get: { operationId: 'readFixture', tags: ['Fixture'], responses: { '200': { description: 'Fixture' } } },
        post: {
          operationId: 'writeFixture', tags: ['Fixture'], 'x-required-permission': 'fixture:write',
          'x-required-permissions': ['fixture:read', 'fixture:write'],
          parameters: [{ in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string' } }],
          responses: { '202': { description: 'Fixture' } },
        },
      },
    },
    components: { parameters: { Key: { in: 'header', name: 'Idempotency-Key', required: false, description: 'Required for fixture service credentials.', schema: { type: 'string' } } } },
  };
}

describe('operation generation (offline fixtures)', () => {
  test('extracts explicit permissions, tags, conservative access and inherited/overridden idempotency', () => {
    const [read, write] = collectOperations(fixture());
    expect(read?.access).toBe('read');
    expect(read?.tags).toEqual(['Fixture']);
    expect(read?.requiredPermissions).toBeNull();
    expect(read?.idempotency).toEqual({ header: 'Idempotency-Key', required: false, description: 'Required for fixture service credentials.' });
    expect(write?.requiredPermissions).toEqual(['fixture:read', 'fixture:write']);
    expect(write?.access).toBe('write');
    expect(write?.idempotency?.required).toBe(true);
    const spec = fixture();
    Object.assign(spec.paths['/api/fixture/{id}'], {
      options: { operationId: 'optionsFixture', responses: {} },
      head: { operationId: 'headFixture', responses: {} },
    });
    const ops = collectOperations(spec);
    expect(ops.find(op => op.method === 'OPTIONS')?.access).toBe('write');
    expect(ops.find(op => op.method === 'HEAD')?.access).toBe('read');
  });

  test('rejects duplicate IDs, malformed permissions and remote/unresolved references without fetch', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => {
      throw new Error('Offline tests must not fetch');
    }, { preconnect: fetch.preconnect }));
    try {
      const spec = fixture();
      spec.paths['/api/fixture/{id}'].post.operationId = 'readFixture';
      expect(() => collectOperations(spec)).toThrow('duplicate');
      const invalid = fixture();
      Object.assign(invalid.paths['/api/fixture/{id}'].post, { 'x-required-permission': 42 });
      expect(() => collectOperations(invalid)).toThrow('permission');
      for (const ref of ['https://fixture.invalid/spec.json', './fixture.json', '#/missing']) {
        const bad = fixture();
        bad.paths['/api/fixture/{id}'].parameters[0]!.$ref = ref;
        await expect(generateOutputs(bad, fixture())).rejects.toThrow();
      }
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  test('generation is deterministic and schema changes affect emitted types', async () => {
    const first = await generateOutputs(fixture(), fixture());
    expect(await generateOutputs(fixture(), fixture())).toEqual(first);
    expect(first['direct.ts']).toContain('readFixture');
    expect(first['operations.ts']).toContain('keyof DirectTypes');
    const changed = fixture();
    changed.paths['/api/fixture/{id}'].post.parameters[0]!.schema.type = 'number';
    expect((await generateOutputs(changed, fixture()))['direct.ts']).not.toBe(first['direct.ts']);
  });

  test('qualifies Platform embedded recursive definitions without altering the source', async () => {
    const spec = fixture();
    const schema = {
      type: 'object', properties: { data: { $ref: '#/definitions/value' } },
      definitions: { value: { anyOf: [
        { type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'string', nullable: true, enum: [null] },
        { type: 'array', items: { $ref: '#/definitions/value' } },
        { type: 'object', additionalProperties: { $ref: '#/definitions/value' } },
      ] } },
    };
    Object.assign(spec.paths['/api/fixture/{id}'].post, { requestBody: { content: { 'application/json': { schema } } } });
    const before = JSON.stringify(spec);
    expect(() => validateSpec(qualifyEmbeddedDefinitions(spec))).not.toThrow();
    const generated = await generateOutputs(fixture(), spec);
    expect(generated['platform.ts']).toContain('__embeddedDefinition0: JsonValue');
    expect(JSON.stringify(spec)).toBe(before);
  });

  test('stale or missing output fails without rewriting it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fixture-operations-'));
    const url = pathToFileURL(directory + '/');
    try {
      const outputs = { 'fixture.ts': '// fixture generated output\n' };
      await expect(writeOutputs(url, outputs, true)).rejects.toThrow('stale');
      await writeOutputs(url, outputs, false);
      await writeOutputs(url, outputs, true);
      await writeFile(new URL('fixture.ts', url), '// fixture stale\n');
      await expect(writeOutputs(url, outputs, true)).rejects.toThrow('stale');
      expect(await readFile(new URL('fixture.ts', url), 'utf8')).toBe('// fixture stale\n');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
