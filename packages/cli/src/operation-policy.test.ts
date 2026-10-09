import { describe, expect, test } from 'bun:test';

import { matchDirectOperation, mcpWriteKind, type DirectOperation } from './operation-policy';

function operation(
  operationId: string,
  method: string,
  path: string,
  access: 'read' | 'write' = 'read',
): DirectOperation {
  return {
    operationId,
    method,
    path,
    tags: ['Fixture'],
    access,
    requiredPermissions: null,
    idempotency: null,
  };
}

describe('MCP operation policy', () => {
  test('prefers an exact static route over a matching template', () => {
    const routes = [
      operation('staticRead', 'GET', '/api/threads/fixed/runs'),
      operation('templatedWrite', 'POST', '/api/threads/{id}/runs', 'write'),
    ];

    expect(matchDirectOperation('GET', '/api/threads/fixed/runs', routes)?.operationId).toBe('staticRead');
    expect(matchDirectOperation('POST', '/api/threads/fixed/runs', routes)).toBeUndefined();
  });

  test('matches an unambiguous operation template and rejects ambiguous templates', () => {
    const routes = [operation('getThread', 'GET', '/api/threads/{id}')];
    expect(matchDirectOperation('GET', '/api/threads/thr_fixture', routes)?.operationId).toBe('getThread');

    const ambiguous = [
      operation('byName', 'GET', '/api/{kind}/fixture'),
      operation('byThread', 'GET', '/api/threads/{id}'),
    ];
    expect(matchDirectOperation('GET', '/api/threads/fixture', ambiguous)).toBeUndefined();
  });

  test('only explicitly approved metadata writes can authorize direct writes', () => {
    expect(mcpWriteKind('POST', '/api/threads/thr_fixture/messages', [
      operation('appendThreadMessage', 'POST', '/api/threads/{id}/messages', 'write'),
    ])).toBe('message');
    expect(mcpWriteKind('POST', '/api/threads/thr_fixture/messages', [
      operation('newWriteFromSpec', 'POST', '/api/threads/{id}/messages', 'write'),
    ])).toBeUndefined();
    expect(mcpWriteKind('POST', '/api/threads/thr_fixture/messages', [
      operation('constructor', 'POST', '/api/threads/{id}/messages', 'write'),
    ])).toBeUndefined();
    expect(mcpWriteKind('POST', '/api/threads/thr_fixture/messages', [
      operation('appendThreadMessage', 'POST', '/api/threads/{id}/messages', 'read'),
    ])).toBeUndefined();
  });

  test('keeps the title compatibility exception explicit and method-limited', () => {
    expect(mcpWriteKind('POST', '/api/threads/thr_fixture/title', [])).toBe('title');
    expect(mcpWriteKind('GET', '/api/threads/thr_fixture/title', [])).toBeUndefined();
  });
});
