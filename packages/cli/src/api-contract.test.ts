import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApiContract, contractDifferences, TOOLKIT_ROUTES } from './api-contract';

const ROUTES = [['GET', '/api/fixture/{id}']] as const;

function fixture() {
  return {
    openapi: '3.1.0',
    paths: {
      '/api/fixture/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          operationId: 'getFixture',
          description: 'Obvious offline fixture',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 10 } }],
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Fixture' } } } },
          responses: {
            '200': {
              description: 'Fixture response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Fixture' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Fixture: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', maxLength: 20 } },
        },
      },
    },
  };
}

function contract(spec: unknown) {
  return buildApiContract(spec, ROUTES);
}

describe('public API contract (offline fixtures only)', () => {
  test('records method/path, operation ID, inherited parameters, body, and resolved responses', () => {
    const result = contract(fixture());
    expect(result.operations).toMatchObject({
      'GET /api/fixture/{id}': {
        method: 'GET', path: '/api/fixture/{id}', operationId: 'getFixture',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 10 } },
        ],
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { content: { 'application/json': { schema: { properties: { name: { maxLength: 20 } } } } } } },
      },
    });
    expect(JSON.stringify(result)).not.toContain('$ref');
  });

  test('detects nested referenced request and response schema changes', () => {
    const before = fixture();
    const after = fixture();
    after.components.schemas.Fixture.properties.name.maxLength = 19;
    const paths = contractDifferences(contract(before), contract(after));
    expect(paths.some(path => path.includes('/requestBody/') && path.endsWith('/maxLength'))).toBe(true);
    expect(paths.some(path => path.includes('/responses/') && path.endsWith('/maxLength'))).toBe(true);
  });

  test('detects operation ID, parameter, required-field, and response-status drift', () => {
    const before = contract(fixture());
    const changes = [
      (spec: ReturnType<typeof fixture>) => { spec.paths['/api/fixture/{id}'].get.operationId = 'changedFixture'; },
      (spec: ReturnType<typeof fixture>) => { spec.paths['/api/fixture/{id}'].get.parameters[0].schema.maximum = 9; },
      (spec: ReturnType<typeof fixture>) => { spec.components.schemas.Fixture.required = []; },
      (spec: ReturnType<typeof fixture>) => { Object.assign(spec.paths['/api/fixture/{id}'].get.responses, { '400': { description: 'Error' } }); },
    ];
    for (const change of changes) {
      const after = fixture();
      change(after);
      expect(contractDifferences(before, contract(after)).length).toBeGreaterThan(0);
    }
  });

  test('ignores descriptions/examples and object-key ordering, not properties with annotation names', () => {
    const before = fixture();
    const after = fixture();
    after.paths['/api/fixture/{id}'].get.description = 'Changed prose';
    Object.assign(after.components.schemas.Fixture, { description: 'New prose', examples: [{ private: 'not pinned' }] });
    Object.assign(after.paths, { '/api/unrelated': { get: { operationId: 'unrelated' } } });
    expect(contractDifferences(contract(before), contract(after))).toEqual([]);
    Object.assign(before.components.schemas.Fixture.properties, { description: { type: 'string' }, examples: { type: 'string' } });
    Object.assign(after.components.schemas.Fixture.properties, { description: { type: 'number' }, examples: { type: 'number' } });
    expect(contractDifferences(contract(before), contract(after))).toHaveLength(4);
    expect(contractDifferences({ b: 1, a: 2 }, { a: 2, b: 1 })).toEqual([]);
  });

  test('retains defaults and literal objects whose keys look like annotations or references', () => {
    const spec = fixture();
    Object.assign(spec.components.schemas.Fixture, { default: { description: 'fixture', $ref: 'literal-not-a-reference' } });
    expect(JSON.stringify(contract(spec))).toContain('literal-not-a-reference');
    const before = contract(spec);
    Object.assign(spec.components.schemas.Fixture, { default: { description: 'changed' } });
    expect(contractDifferences(before, contract(spec)).length).toBeGreaterThan(0);
  });

  test('resolves parameter refs and applies operation-level parameter overrides', () => {
    const spec = fixture();
    Object.assign(spec.components, { parameters: { Id: { name: 'id', in: 'path', required: true, schema: { type: 'integer' } } } });
    Object.assign(spec.paths['/api/fixture/{id}'].get, { parameters: [{ $ref: '#/components/parameters/Id' }] });
    const result = JSON.stringify(contract(spec));
    expect(result).not.toContain('$ref');
    expect(result.match(/"name":"id"/g)).toHaveLength(1);
    expect(result).toContain('"schema":{"type":"integer"}');
  });

  test('bounds cycles without hiding changes on recursive schemas', () => {
    const spec = fixture();
    Object.assign(spec.components.schemas.Fixture.properties, { next: { $ref: '#/components/schemas/Fixture' } });
    const before = contract(spec);
    expect(JSON.stringify(before)).toContain('"$ref":"#/components/schemas/Fixture"');
    spec.components.schemas.Fixture.properties.name.maxLength = 18;
    expect(contractDifferences(before, contract(spec)).length).toBeGreaterThan(0);
  });

  test('preserves constraints beside refs and resolves escaped pointer names', () => {
    const spec = fixture();
    Object.assign(spec.components.schemas, { 'fixture/name~': { type: 'string', maxLength: 30 } });
    Object.assign(spec.components.schemas.Fixture.properties.name, {
      $ref: '#/components/schemas/fixture~1name~0', minLength: 1,
    });
    const result = JSON.stringify(contract(spec));
    expect(result).toContain('"maxLength":30');
    expect(result).toContain('"minLength":1');
    expect(result).not.toContain('$ref');
  });

  test('fails closed for missing routes/methods, unresolved/external refs, and excessive depth', () => {
    const missing = fixture();
    Object.assign(missing.paths, { '/api/fixture/{id}': {} });
    expect(() => contract(missing)).toThrow('Missing operation');
    expect(() => buildApiContract({ openapi: '3.1.0', paths: {} }, ROUTES)).toThrow('Missing route');
    for (const ref of ['#/components/schemas/Missing', 'https://fixture.invalid/schema.json']) {
      const spec = fixture();
      spec.paths['/api/fixture/{id}'].get.responses['200'].content['application/json'].schema.$ref = ref;
      expect(() => contract(spec)).toThrow();
    }
    const deep = fixture();
    let nested: Record<string, unknown> = deep.components.schemas.Fixture;
    for (let i = 0; i < 100; i++) {
      nested.items = {};
      nested = nested.items as Record<string, unknown>;
    }
    expect(() => contract(deep)).toThrow('node/depth bound');
  });

  test('bounds drift diagnostics and never prints changed values', () => {
    expect(contractDifferences({ a: 'fixture-secret' }, { a: 'other-secret' })).toEqual(['/a']);
    expect(contractDifferences({ a: 1, b: 2, c: 3 }, { a: 4, b: 5, c: 6 }, 2)).toHaveLength(2);
  });

  test('pins only the explicit toolkit subset and excludes undocumented operations', () => {
    const pinned = JSON.parse(readFileSync(new URL('../../../docs/api-contract.json', import.meta.url), 'utf8'));
    expect(Object.keys(pinned.operations).sort()).toEqual(TOOLKIT_ROUTES.map(([m, p]) => `${m} ${p}`).sort());
    expect(pinned.operations['GET /api/model-providers']).toBeDefined();
    expect(JSON.stringify(pinned)).not.toMatch(/execution-capability|preview-checklist|\/title/);
  });

  test('script checks a local fixture spec without network or file updates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-contract-fixture-'));
    const file = join(dir, 'openapi.json');
    const script = join(dir, 'scripts/check-api-contract.ts');
    const snapshotPath = join(dir, 'docs/api-contract.json');
    const example = fixture();
    Object.assign(example.components.schemas.Fixture.properties, { next: { $ref: '#/components/schemas/Fixture' } });
    const spec = {
      openapi: example.openapi,
      components: example.components,
      paths: {} as Record<string, Record<string, unknown>>,
    };
    for (const [method, path] of TOOLKIT_ROUTES) {
      spec.paths[path] ??= {};
      spec.paths[path][method.toLowerCase()] = structuredClone(example.paths['/api/fixture/{id}'].get);
    }
    const original = JSON.stringify(buildApiContract(spec));
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, script, ...args]);
    try {
      for (const path of ['scripts', 'docs', 'packages/cli/src/generated']) mkdirSync(join(dir, path), { recursive: true });
      writeFileSync(script, readFileSync(new URL('../../../scripts/check-api-contract.ts', import.meta.url)));
      writeFileSync(join(dir, 'packages/cli/src/api-contract.ts'), readFileSync(new URL('./api-contract.ts', import.meta.url)));
      writeFileSync(join(dir, 'packages/cli/src/generated/operations.ts'), readFileSync(new URL('./generated/operations.ts', import.meta.url)));
      writeFileSync(snapshotPath, original);
      writeFileSync(file, JSON.stringify(spec));
      const matched = run('--file', file);
      expect(matched.exitCode).toBe(0);
      expect(matched.stdout.toString()).toContain(`matches the pinned ${TOOLKIT_ROUTES.length} operations`);
      const changed = spec.paths['/api/model-providers'].get as Record<string, unknown>;
      changed.operationId = 'changedFixture';
      writeFileSync(file, JSON.stringify(spec));
      const drift = run('--file', file);
      expect(drift.exitCode).toBe(1);
      expect(drift.stderr.toString()).toContain('contract drift');
      expect(drift.stderr.toString()).toContain('operationId');
      expect(readFileSync(snapshotPath, 'utf8')).toBe(original);
      expect(run().exitCode).toBe(1);
      expect(run('--live', '--file', file).exitCode).toBe(1);
      writeFileSync(file, '{fixture-secret-invalid-json');
      const invalid = run('--file', file);
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr.toString()).not.toContain('fixture-secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
