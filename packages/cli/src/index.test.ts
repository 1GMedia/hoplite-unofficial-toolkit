import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  apiKeySummary,
  authSummary,
  buildReadApiRequest,
  buildThreadActionRequest,
  createThreadBodyFromFlags,
  parseBoolean,
  parseCliArgs,
  redactText,
  redactSecrets,
  requireConfirmation,
  messageTextFromFlags,
  normalizeOAuthRefreshResponse,
  oauthNeedsRefresh,
  refreshOAuthState,
  sanitizeOutput,
  summarizeTimeline,
  summarizeApiResponse,
  validateMutationPath,
} from './index';

const TEST_THREAD_IDS = ['thr_testalpha123', 'thr_testbeta456'] as const;
const TEST_ALLOWLIST = new Set<string>(TEST_THREAD_IDS);

describe('hoplite-cli', () => {
  test('parses positional values and both flag forms', () => {
    const parsed = parseCliArgs([
      'inspect',
      'thr_abc123',
      '--limit=25',
      '--archived',
      'false',
    ]);
    expect(parsed.command).toBe('inspect');
    expect(parsed.positionals).toEqual(['thr_abc123']);
    expect(parsed.flags.get('limit')).toBe('25');
    expect(parsed.flags.get('archived')).toBe('false');
  });

  test('parses strict booleans', () => {
    expect(parseBoolean('true', false)).toBe(true);
    expect(parseBoolean('no', true)).toBe(false);
    expect(() => parseBoolean('sometimes', false)).toThrow();
  });

  test('redacts token-like fields and URLs', () => {
    const input = 'password=hunter2 accessToken: abc123 see https://example.com/private?q=1';
    const output = redactText(input);
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('abc123');
    expect(output).not.toContain('example.com');
    expect(output).toContain('[redacted]');
    expect(output).toContain('[url]');
  });

  test('redacts an exact API key without exposing it', () => {
    const secret = 'fixture_api_key_value_123456789';
    expect(redactSecrets(`Authorization: Bearer ${secret}`, [secret])).not.toContain(secret);
  });

  test('requires confirmation for direct API mutations', () => {
    const flags = new Map<string, string>();
    expect(() => requireConfirmation(flags, 'POST')).toThrow('--confirm');
    flags.set('confirm', 'true');
    expect(() => requireConfirmation(flags, 'POST')).not.toThrow();
    expect(() => requireConfirmation(new Map(), 'GET')).not.toThrow();
  });

  test('limits direct API paths to a caller-configured allowlist', () => {
    const [threadId, otherThreadId] = TEST_THREAD_IDS;
    expect(validateMutationPath(`/api/threads/${threadId}/messages`, threadId, TEST_ALLOWLIST)).toContain(threadId);
    expect(() => validateMutationPath('/api/projects', threadId, TEST_ALLOWLIST)).toThrow('allowlist');
    expect(() => validateMutationPath('/api/threads/thr_notallowed/messages', undefined, TEST_ALLOWLIST)).toThrow('allowlist');
    expect(() => validateMutationPath(`/api/threads/${threadId}/messages`, otherThreadId, TEST_ALLOWLIST)).toThrow('match');
    expect(() => validateMutationPath(`/api/threads/${threadId}/messages`, threadId, new Set())).toThrow('disabled');
  });

  test('validates message targets and bounded content', () => {
    const [threadId] = TEST_THREAD_IDS;
    expect(messageTextFromFlags([threadId], new Map([['text', 'status']]), TEST_ALLOWLIST)).toBe('status');
    expect(() => messageTextFromFlags(['thr_notallowlisted'], new Map([['text', 'status']]), TEST_ALLOWLIST)).toThrow('allowlist');
    expect(() => messageTextFromFlags([threadId], new Map(), TEST_ALLOWLIST)).toThrow('message is required');
  });

  test('builds reviewed read-only API routes with bounded query values', () => {
    expect(buildReadApiRequest('repositories', [], new Map())).toEqual({
      method: 'GET',
      path: '/api/source-control/github/repositories',
    });
    expect(buildReadApiRequest('branches', ['repo/acme'], new Map())).toEqual({
      method: 'GET',
      path: '/api/source-control/github/repositories/repo%2Facme/branches',
    });
    expect(buildReadApiRequest('messages', ['thr_abc123'], new Map([
      ['limit', '50'],
      ['activity-limit', '200'],
    ]))).toEqual({
      method: 'GET',
      path: '/api/threads/thr_abc123/messages',
      query: { limit: 50, activityLimit: 200 },
    });
    expect(() => buildReadApiRequest('messages', ['thr_abc123'], new Map([['limit', '501']]))).toThrow();
    expect(() => buildReadApiRequest('messages', ['thr_abc123'], new Map([
      ['cursor', 'x'.repeat(513)],
    ]))).toThrow('message cursor');
  });

  test('builds only confirmed allowlisted lifecycle actions', () => {
    const [threadId] = TEST_THREAD_IDS;
    expect(() => buildThreadActionRequest('thread-retry', [threadId], new Map(), TEST_ALLOWLIST)).toThrow('--confirm');
    expect(() => buildThreadActionRequest('thread-retry', ['thr_notallowed'], new Map([
      ['confirm', 'true'],
    ]), TEST_ALLOWLIST)).toThrow('allowlist');
    const request = buildThreadActionRequest('thread-stop', [threadId], new Map([
      ['confirm', 'true'],
      ['run-id', 'run_abc123'],
      ['client-operation-id', 'codex-stop-001'],
    ]), TEST_ALLOWLIST);
    expect(request).toEqual({
      action: 'thread-stop',
      threadId,
      clientOperationId: 'codex-stop-001',
      method: 'POST',
      path: `/api/threads/${threadId}/stop`,
      body: { clientOperationId: 'codex-stop-001', runId: 'run_abc123' },
    });
    expect(() => buildThreadActionRequest('thread-stop', [threadId], new Map([
      ['confirm', 'true'],
    ]), TEST_ALLOWLIST)).toThrow('run id');
    for (const [command, suffix] of [
      ['thread-retry', 'retry'],
      ['thread-compact', 'compact'],
      ['thread-auto-title', 'title'],
    ] as const) {
      const action = buildThreadActionRequest(command, [threadId], new Map([
        ['confirm', 'true'],
        ['client-operation-id', `codex-${suffix}-001`],
      ]), TEST_ALLOWLIST);
      expect(action.path).toBe(`/api/threads/${threadId}/${suffix}`);
      expect(action.body).toEqual({ clientOperationId: `codex-${suffix}-001` });
    }
  });

  test('requires an explicit idempotency key before creating a task', () => {
    expect(() => createThreadBodyFromFlags(['prj_abc', 'Do', 'the', 'work'], new Map([
      ['confirm', 'true'],
    ]))).toThrow('client-operation-id');
    expect(createThreadBodyFromFlags(['prj_abc'], new Map([
      ['confirm', 'true'],
      ['prompt', 'Do the work'],
      ['client-operation-id', 'create-001'],
      ['model', 'gpt-5.6-terra'],
    ]))).toEqual({
      projectId: 'prj_abc',
      prompt: 'Do the work',
      clientOperationId: 'create-001',
      model: 'gpt-5.6-terra',
    });
  });

  test('bounds and redacts nested unofficial API output', () => {
    const sanitized = sanitizeOutput({
      token: 'must-never-appear',
      nested: {
        url: 'https://example.com/private',
        content: 'safe text',
      },
    });
    expect(JSON.stringify(sanitized)).not.toContain('must-never-appear');
    expect(JSON.stringify(sanitized)).not.toContain('example.com');
    expect(JSON.stringify(sanitized)).toContain('safe text');
  });

  test('summarizes bounded timeline roles and age', () => {
    const body = {
      items: [
        {
          kind: 'message',
          message: {
            role: 'user',
            createdAt: '2026-08-03T00:00:00.000Z',
            content: 'status?',
          },
        },
        {
          kind: 'message',
          message: {
            role: 'assistant',
            createdAt: '2026-08-03T00:00:10.000Z',
            content: 'running at https://secret.example/token',
          },
        },
      ],
      hasMore: false,
    };
    const summary = summarizeTimeline(body, Date.parse('2026-08-03T00:00:20.000Z'));
    expect(summary.lastActivityAgeSeconds).toBe(10);
    expect(JSON.stringify(summary)).not.toContain('secret.example');
  });

  test('reports expiry and safe permissions without exposing token values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoplite-cli-test-'));
    try {
      const path = join(dir, 'oauth.json');
      writeFileSync(path, JSON.stringify({
        resource: 'https://api.hoplite.sh/mcp',
        accessToken: 'must-never-appear',
        tokenType: 'Bearer',
        expiresAt: '2026-08-03T00:00:00.000Z',
      }), { mode: 0o600 });
      const summary = authSummary(path, Date.parse('2026-08-03T00:00:01.000Z'));
      expect(summary.expired).toBe(true);
      expect(JSON.stringify(summary)).not.toContain('must-never-appear');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refreshes an expired OAuth token and persists it with safe permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoplite-oauth-refresh-test-'));
    const path = join(dir, 'oauth.json');
    try {
      writeFileSync(path, JSON.stringify({
        baseUrl: 'https://api.hoplite.sh',
        clientId: 'client_test',
        resource: 'https://api.hoplite.sh/mcp',
        refreshToken: 'refresh_secret_value',
        accessToken: 'expired_access_value',
        tokenType: 'Bearer',
        expiresAt: '2026-08-03T00:00:00.000Z',
        scope: 'openid offline_access',
      }), { mode: 0o600 });
      let requestBody = '';
      const refreshed = await refreshOAuthState(
        path,
        Date.parse('2026-08-03T00:00:01.000Z'),
        async (_input, init) => {
          requestBody = String(init?.body);
          return new Response(JSON.stringify({
            access_token: 'fresh_access_value',
            refresh_token: 'fresh_refresh_value',
            token_type: 'Bearer',
            expires_in: 3600,
          }), { status: 200 });
        },
      );
      expect(requestBody).toContain('grant_type=refresh_token');
      expect(requestBody).toContain('client_id=client_test');
      expect(refreshed.accessToken).toBe('fresh_access_value');
      expect(refreshed.refreshToken).toBe('fresh_refresh_value');
      expect(oauthNeedsRefresh(refreshed, Date.parse('2026-08-03T00:00:02.000Z'))).toBe(false);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const persisted = readFileSync(path, 'utf8');
      expect(persisted).toContain('fresh_access_value');
      expect(persisted).not.toContain('expired_access_value');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normalizes refresh responses that rotate only the access token', () => {
    const current = {
      resource: 'https://api.hoplite.sh/mcp',
      clientId: 'client_test',
      refreshToken: 'refresh_value',
      accessToken: 'old_access',
      tokenType: 'Bearer',
      expiresAt: '2026-08-03T00:00:00.000Z',
    };
    const refreshed = normalizeOAuthRefreshResponse(current, {
      access_token: 'new_access',
      expires_in: 1800,
    }, Date.parse('2026-08-03T00:00:00.000Z'));
    expect(refreshed.accessToken).toBe('new_access');
    expect(refreshed.refreshToken).toBe('refresh_value');
    expect(refreshed.expiresAt).toBe('2026-08-03T00:30:00.000Z');
  });

  test('reports API-key presence without exposing its value', () => {
    const previous = process.env.HOPLITE_API_KEY;
    const previousCredentialsPath = process.env.HOPLITE_CREDENTIALS_PATH;
    const dir = mkdtempSync(join(tmpdir(), 'hoplite-api-key-test-'));
    try {
      delete process.env.HOPLITE_API_KEY;
      process.env.HOPLITE_CREDENTIALS_PATH = join(dir, 'missing.json');
      expect(apiKeySummary().keyPresent).toBe(false);
      process.env.HOPLITE_API_KEY = 'fixture_api_key_value_123456789';
      const summary = apiKeySummary();
      expect(summary.keyPresent).toBe(true);
      expect(JSON.stringify(summary)).not.toContain('fixture_api_key_value_123456789');
    } finally {
      if (previous === undefined) delete process.env.HOPLITE_API_KEY;
      else process.env.HOPLITE_API_KEY = previous;
      if (previousCredentialsPath === undefined) delete process.env.HOPLITE_CREDENTIALS_PATH;
      else process.env.HOPLITE_CREDENTIALS_PATH = previousCredentialsPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts the native Hoplite credentials file without printing the key', () => {
    const previous = process.env.HOPLITE_API_KEY;
    const previousCredentialsPath = process.env.HOPLITE_CREDENTIALS_PATH;
    const dir = mkdtempSync(join(tmpdir(), 'hoplite-api-key-file-test-'));
    const path = join(dir, 'credentials.json');
    try {
      delete process.env.HOPLITE_API_KEY;
      process.env.HOPLITE_CREDENTIALS_PATH = path;
      writeFileSync(path, JSON.stringify({
        credentials: [{ apiKey: 'fixture_file_key_value_123456789', baseUrl: 'https://api.hoplite.sh' }],
      }), { mode: 0o600 });
      const summary = apiKeySummary();
      expect(summary.ok).toBe(true);
      expect(JSON.stringify(summary)).not.toContain('fixture_file_key_value_123456789');
    } finally {
      if (previous === undefined) delete process.env.HOPLITE_API_KEY;
      else process.env.HOPLITE_API_KEY = previous;
      if (previousCredentialsPath === undefined) delete process.env.HOPLITE_CREDENTIALS_PATH;
      else process.env.HOPLITE_CREDENTIALS_PATH = previousCredentialsPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('bounds direct API responses and drops timeline content', () => {
    const summary = summarizeApiResponse(JSON.stringify({
      ok: true,
      hasMore: false,
      items: [{ kind: 'message', message: { content: 'private prompt' } }],
    }), 'fixture_api_key_value_123456789');
    expect(summary.itemCount).toBe(1);
    expect(JSON.stringify(summary)).not.toContain('private prompt');
  });
});
