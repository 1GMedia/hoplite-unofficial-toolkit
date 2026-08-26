import { describe, expect, test } from 'bun:test';

import {
  buildProjectEnvironmentListRequest,
  executeProjectEnvironmentList,
  parseProjectEnvironmentEntries,
  parseProjectEnvironmentResponse,
  validatedEnvironmentKey,
  validatedProjectId,
} from './project-environment-commands';

function toolResult(response: unknown): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(response) }],
  };
}

describe('project-environment-list', () => {
  test('validates project identifiers at their exact boundaries', () => {
    expect(validatedProjectId('p')).toBe('p');
    expect(validatedProjectId(`p${'a'.repeat(127)}`)).toHaveLength(128);
    for (const invalid of [undefined, '', '-project', 'project/id', 'project id', `p${'a'.repeat(128)}`]) {
      expect(() => validatedProjectId(invalid)).toThrow('valid Hoplite project id');
    }
  });

  test('validates environment keys at their exact boundaries', () => {
    expect(validatedEnvironmentKey('A')).toBe('A');
    expect(validatedEnvironmentKey(`A${'1'.repeat(127)}`)).toHaveLength(128);
    for (const invalid of ['', '1KEY', 'HAS-DASH', 'HAS.DOT', `A${'1'.repeat(128)}`]) {
      expect(() => validatedEnvironmentKey(invalid)).toThrow('invalid key');
    }
  });

  test('builds one exact encoded read path', () => {
    expect(buildProjectEnvironmentListRequest('prj_example_123')).toEqual({
      method: 'GET',
      path: '/api/projects/prj_example_123/env-vars',
    });
    expect(() => buildProjectEnvironmentListRequest('prj/escape')).toThrow();
  });

  test('strictly projects and sorts metadata', () => {
    expect(parseProjectEnvironmentEntries([
      { key: 'ZETA' },
      { key: 'ALPHA', updatedAt: '2026-08-25T12:00:00.000Z' },
    ])).toEqual([
      { key: 'ALPHA', updatedAt: '2026-08-25T12:00:00.000Z' },
      { key: 'ZETA' },
    ]);
  });

  test('fails closed on secret-bearing or unknown fields', () => {
    for (const entry of [
      { key: 'SAFE', value: 'fixture-secret' },
      { key: 'SAFE', secretValue: 'fixture-secret' },
      { key: 'SAFE', description: 'unexpected' },
    ]) {
      expect(() => parseProjectEnvironmentEntries([entry])).toThrow('schema drift');
    }
  });

  test('bounds the response array', () => {
    expect(parseProjectEnvironmentEntries(Array.from({ length: 500 }, (_, index) => ({ key: `KEY_${index}` })))).toHaveLength(500);
    expect(() => parseProjectEnvironmentEntries(Array.from({ length: 501 }, (_, index) => ({ key: `KEY_${index}` })))).toThrow('exceeds 500');
  });

  test('distinguishes credential, role, project-or-route, and absent-route errors', () => {
    expect(() => parseProjectEnvironmentResponse({ ok: false, status: 401 })).toThrow('credential unsupported');
    expect(() => parseProjectEnvironmentResponse({ ok: false, status: 403 })).toThrow('workspace role');
    expect(() => parseProjectEnvironmentResponse({ ok: false, status: 404 })).toThrow('project or route');
    expect(() => parseProjectEnvironmentResponse({ ok: false, status: 405 })).toThrow('route is absent');
  });

  test('rejects an invalid or contradictory HTTP ok flag as schema drift', () => {
    expect(() => parseProjectEnvironmentResponse({ ok: 'yes', status: 200, body: [] })).toThrow('invalid HTTP ok flag');
    expect(() => parseProjectEnvironmentResponse({ ok: false, status: 200, body: [] })).toThrow('status and ok flag disagree');
  });

  test('reports response schema drift without including response values', () => {
    const fixtureSecret = 'fixture-private-value-never-output';
    let message = '';
    try {
      parseProjectEnvironmentResponse({ ok: true, status: 200, body: [{ key: 'SAFE', value: fixtureSecret }] });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('schema drift');
    expect(message).not.toContain(fixtureSecret);
  });

  test('rejects unknown top-level response fields without reflecting their values', () => {
    const fixtureSecret = 'fixture-top-level-private-value';
    let message = '';
    try {
      parseProjectEnvironmentResponse({
        ok: true,
        status: 200,
        body: [],
        value: fixtureSecret,
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('HTTP response contains an unrecognized field');
    expect(message).not.toContain(fixtureSecret);
  });

  test('rejects extra resource content without reflecting its values', async () => {
    const fixtureSecret = 'fixture-resource-private-value';
    let message = '';
    try {
      await executeProjectEnvironmentList({
        callTool: async () => ({
          content: [
            { type: 'text', text: JSON.stringify({ ok: true, status: 200, body: [] }) },
            { type: 'resource', resource: { uri: 'fixture://private', text: fixtureSecret } },
          ],
        }),
      }, 'prj_example');
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('MCP returned unexpected content');
    expect(message).not.toContain(fixtureSecret);
  });

  test('makes exactly one request and returns a secret-free bounded projection', async () => {
    const calls: unknown[] = [];
    const output = await executeProjectEnvironmentList({
      callTool: async request => {
        calls.push(request);
        return toolResult({
          ok: true,
          status: 200,
          body: [{ key: 'PUBLIC_NAME', updatedAt: '2026-08-25T12:00:00.000Z' }],
        });
      },
    }, 'prj_example', new Date('2026-08-25T13:00:00.000Z'));
    expect(calls).toEqual([{
      name: 'hoplite_call_api',
      arguments: { method: 'GET', path: '/api/projects/prj_example/env-vars' },
    }]);
    expect(output).toEqual({
      checkedAt: '2026-08-25T13:00:00.000Z',
      projectId: 'prj_example',
      variables: [{ key: 'PUBLIC_NAME', updatedAt: '2026-08-25T12:00:00.000Z' }],
      capability: {
        id: 'project.environment.list',
        mode: 'read-only',
        localImplementation: 'available',
        remoteAuthentication: 'unverified',
        source: 'authenticated-client-contract',
      },
    });
    const serialized = JSON.stringify(output);
    for (const forbidden of ['value', 'secret', 'token', 'password', 'authorization', 'apiKey']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  test('does not retry failures', async () => {
    let calls = 0;
    await expect(executeProjectEnvironmentList({
      callTool: async () => {
        calls += 1;
        return toolResult({ ok: false, status: 503 });
      },
    }, 'prj_example')).rejects.toThrow('HTTP 503');
    expect(calls).toBe(1);
  });

  test('does not reflect transport exception details or retry', async () => {
    const fixtureSecret = 'fixture-transport-private-value';
    let calls = 0;
    let message = '';
    try {
      await executeProjectEnvironmentList({
        callTool: async () => {
          calls += 1;
          throw new Error(`socket failed with ${fixtureSecret}`);
        },
      }, 'prj_example');
    } catch (error) {
      message = String(error);
    }
    expect(calls).toBe(1);
    expect(message).toBe('Error: Project environment request transport failed; no remote error details were retained');
    expect(message).not.toContain(fixtureSecret);
  });
});
