#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type JsonObject = Record<string, unknown>;

type OAuthState = {
  version?: string | number;
  baseUrl?: string;
  clientId?: string;
  scope?: string;
  resource: string;
  refreshToken?: string;
  accessToken: string;
  tokenType: string;
  expiresAt: string;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ApiCredential = {
  apiKey?: string;
  baseUrl?: string;
  orgId?: string;
};

type ParsedArgs = {
  command: string;
  positionals: string[];
  flags: Map<string, string>;
};

type TimelineMessage = {
  role?: string;
  content?: string;
  createdAt?: string;
};

const DEFAULT_TOKEN_PATH = join(homedir(), '.config', 'hoplite', 'mcp-oauth.json');
const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.config', 'hoplite', 'credentials.json');
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_API_BASE_URL = 'https://api.hoplite.sh';
// Refresh early so a delayed command or short outage cannot carry an expired
// access token into an MCP connection.
const OAUTH_REFRESH_WINDOW_MS = 10 * 60_000;
const THREAD_ID_RE = /^thr_[A-Za-z0-9]+$/;
const ALLOWED_THREAD_STATUSES = new Set([
  'queued',
  'running',
  'waiting',
  'blocked',
  'ready',
  'failed',
  'archived',
]);
const THREAD_READ_COMMANDS = new Set([
  'messages',
  'thread-capability',
  'thread-usage',
  'thread-pr-status',
  'thread-pr-comments',
  'thread-preview-checklist',
]);
const THREAD_ACTION_COMMANDS = new Set([
  'thread-stop',
  'thread-retry',
  'thread-compact',
  'thread-auto-title',
]);
const OUTPUT_SENSITIVE_KEY_RE = /(?:access|refresh)?token|password|authorization|api[_-]?key|secret|login[_-]?url|upload[_-]?url|terminal|logs?/i;

export function parseCliArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? 'help';
  const positionals: string[] = [];
  const flags = new Map<string, string>();

  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }

    const raw = value.slice(2);
    const separator = raw.indexOf('=');
    if (separator >= 0) {
      flags.set(raw.slice(0, separator), raw.slice(separator + 1));
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags.set(raw, next);
      index += 1;
    } else {
      flags.set(raw, 'true');
    }
  }

  return { command, positionals, flags };
}

export function redactText(input: string): string {
  return input
    .replace(
      /((?:access|refresh)[_-]?token|password|authorization|api[_-]?key|secret|login[_-]?url)\s*[:=]\s*["']?[^\s"',}\]]+/gi,
      '$1=[redacted]',
    )
    .replace(/https?:\/\/[^\s)\]}>]+/gi, '[url]')
    .replace(/\s+/g, ' ')
    .trim();
}

export function redactSecrets(input: string, secrets: readonly string[] = []): string {
  let output = input;
  for (const secret of secrets) {
    if (secret.length >= 8) output = output.split(secret).join('[redacted]');
  }
  return redactText(output);
}

function redactOAuthTokens(input: string): string {
  return redactText(input)
    .replace(/"accessToken"\s*:\s*"[^"]+"/g, '"accessToken":"[redacted]"')
    .replace(/"refreshToken"\s*:\s*"[^"]+"/g, '"refreshToken":"[redacted]"')
    .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[redacted]"')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"[redacted]"')
    .slice(0, 800);
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactOAuthTokens(message);
}

function normalizeExpiresAt(raw: unknown, now: number): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return new Date(now + raw * 1_000).toISOString();
  }
  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

export function normalizeOAuthRefreshResponse(
  current: OAuthState,
  response: JsonObject,
  now: number,
): OAuthState {
  const accessToken = typeof response.access_token === 'string' ? response.access_token : current.accessToken;
  const tokenType = typeof response.token_type === 'string' ? response.token_type : current.tokenType;
  const refreshToken = typeof response.refresh_token === 'string'
    ? response.refresh_token
    : current.refreshToken;
  const expiresAt = normalizeExpiresAt(
    response.expiresAt
      ?? response.expires_in
      ?? response.expires_at
      ?? response.expires_in_seconds
      ?? response.expiresAt,
    now,
  ) ?? current.expiresAt;

  if (!accessToken || !tokenType || !expiresAt) {
    throw new Error('OAuth refresh response missing required token fields');
  }

  return {
    ...current,
    accessToken,
    tokenType,
    refreshToken,
    expiresAt,
    ...(typeof response.scope === 'string' ? { scope: response.scope } : {}),
  };
}

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  throw new Error(`Expected a boolean, received ${value}`);
}

export function configuredMutationAllowlist(
  raw = process.env.HOPLITE_MUTATION_ALLOWLIST ?? '',
): Set<string> {
  const values = raw.split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
  const allowlist = new Set<string>();
  for (const value of values) allowlist.add(validatedThreadId(value));
  return allowlist;
}

function requireAllowlistedThread(threadId: string, allowlist: ReadonlySet<string>): void {
  if (allowlist.size === 0) {
    throw new Error('Mutations are disabled. Configure HOPLITE_MUTATION_ALLOWLIST first');
  }
  if (!allowlist.has(threadId)) {
    throw new Error('The target thread is not in the configured mutation allowlist');
  }
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function tokenPath(): string {
  return process.env.HOPLITE_OAUTH_PATH || DEFAULT_TOKEN_PATH;
}

function readOAuthState(path: string): OAuthState {
  return JSON.parse(readFileSync(path, 'utf8')) as OAuthState;
}

function writeOAuthStateAtomic(path: string, state: OAuthState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(temp, path);
}

async function acquireOAuthRefreshLock(path: string): Promise<() => void> {
  const lockPath = `${path}.refresh.lock`;
  const startedAt = Date.now();
  while (true) {
    try {
      writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // best effort
        }
      };
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (Date.now() - startedAt >= 30_000) {
        throw new Error('Hoplite OAuth refresh is already in progress');
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

function oauthTokenEndpoint(state: OAuthState): string {
  const baseUrl = state.baseUrl?.trim() || new URL(state.resource).origin;
  const url = new URL('/api/auth/oauth2/token', baseUrl);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('Hoplite OAuth token endpoint must use HTTPS');
  }
  return url.toString();
}

export function oauthNeedsRefresh(state: OAuthState, now = Date.now()): boolean {
  const expiresAtMs = Date.parse(state.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= now + OAUTH_REFRESH_WINDOW_MS;
}

export async function refreshOAuthState(
  path = tokenPath(),
  now = Date.now(),
  fetcher: FetchLike = fetch,
): Promise<OAuthState> {
  const initial = readOAuthState(path);
  if (!oauthNeedsRefresh(initial, now)) return initial;
  const release = await acquireOAuthRefreshLock(path);
  try {
    const current = readOAuthState(path);
    if (!oauthNeedsRefresh(current, now)) return current;
    if (!current.refreshToken || !current.clientId) {
      throw new Error('Hoplite OAuth cannot auto-refresh because refreshToken or clientId is missing. Run: hoplite mcp start');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
      client_id: current.clientId,
    });
    if (current.scope) body.set('scope', current.scope);
    if (current.resource) body.set('resource', current.resource);

    const response = await fetcher(oauthTokenEndpoint(current), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Hoplite OAuth refresh failed (HTTP ${response.status}): ${redactOAuthTokens(raw)}`);
    }

    let parsed: JsonObject;
    try {
      parsed = JSON.parse(raw) as JsonObject;
    } catch {
      throw new Error('Hoplite OAuth refresh returned invalid JSON');
    }
    const refreshed = normalizeOAuthRefreshResponse(current, parsed, now);
    writeOAuthStateAtomic(path, refreshed);
    return refreshed;
  } finally {
    release();
  }
}

export function authSummary(path = tokenPath(), now = Date.now()): JsonObject {
  if (!existsSync(path)) {
    return {
      ok: false,
      authenticated: false,
      tokenPath: path,
      reason: 'oauth_file_missing',
      recovery: 'hoplite mcp start',
    };
  }

  const stat = statSync(path);
  const mode = stat.mode & 0o777;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<OAuthState>;
  const expiresAtMs = Date.parse(parsed.expiresAt ?? '');
  const expired = !Number.isFinite(expiresAtMs) || expiresAtMs <= now;
  const shapeValid = Boolean(
    parsed.resource
      && parsed.accessToken
      && parsed.tokenType
      && Number.isFinite(expiresAtMs),
  );
  const permissionsSafe = (mode & 0o077) === 0;

  return {
    ok: shapeValid && permissionsSafe && !expired,
    authenticated: shapeValid && !expired,
    tokenPath: path,
    mode: mode.toString(8).padStart(3, '0'),
    permissionsSafe,
    resource: parsed.resource ?? null,
    tokenType: parsed.tokenType ?? null,
    expiresAt: parsed.expiresAt ?? null,
    expired,
    recovery: expired || !shapeValid ? 'hoplite mcp start' : null,
  };
}

function credentialsPath(): string {
  return process.env.HOPLITE_CREDENTIALS_PATH || DEFAULT_CREDENTIALS_PATH;
}

function loadApiCredential(): { key: string; baseUrl: string; source: string; orgId?: string } {
  const fromEnv = process.env.HOPLITE_API_KEY?.trim();
  if (fromEnv) {
    return {
      key: fromEnv,
      baseUrl: process.env.HOPLITE_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL,
      source: 'HOPLITE_API_KEY environment variable',
      orgId: process.env.HOPLITE_ORG_ID?.trim() || undefined,
    };
  }

  const path = credentialsPath();
  if (!existsSync(path)) throw new Error('HOPLITE_API_KEY is not set and Hoplite credentials file is missing');
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error('Hoplite credentials file permissions must be 600 or stricter');
  let parsed: { credentials?: ApiCredential[] };
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as { credentials?: ApiCredential[] };
  } catch {
    throw new Error('Hoplite credentials file is not valid JSON');
  }
  const credential = parsed.credentials?.find(item => item.apiKey && item.baseUrl) ?? parsed.credentials?.find(item => item.apiKey);
  if (!credential?.apiKey) throw new Error('Hoplite credentials file has no API key');
  return {
    key: credential.apiKey,
    baseUrl: process.env.HOPLITE_API_BASE_URL?.trim() || credential.baseUrl || DEFAULT_API_BASE_URL,
    source: `Hoplite credentials file (${path})`,
    orgId: process.env.HOPLITE_ORG_ID?.trim() || (credential as ApiCredential).orgId,
  };
}

export function apiKeySummary(): JsonObject {
  try {
    const credential = loadApiCredential();
    return {
      ok: true,
      authenticated: true,
      source: credential.source,
      keyPresent: true,
      permissionsSafe: true,
      recovery: null,
    };
  } catch (error) {
    const message = safeErrorMessage(error);
    const present = Boolean(process.env.HOPLITE_API_KEY?.trim());
    return {
      ok: false,
      authenticated: false,
      source: present ? 'HOPLITE_API_KEY environment variable' : 'environment or Hoplite credentials file',
      keyPresent: present,
      permissionsSafe: null,
      recovery: message,
    };
  }
}

async function loadOAuthState(): Promise<OAuthState> {
  const path = tokenPath();
  const summary = authSummary(path);
  if (summary.permissionsSafe !== true) {
    throw new Error('Hoplite OAuth file permissions must be 600 or stricter');
  }
  if (summary.authenticated !== true && summary.expired !== true) {
    throw new Error(
      `Hoplite OAuth is unavailable (${String(summary.reason ?? (summary.expired ? 'token_expired' : 'invalid_oauth_state'))}). Run: hoplite mcp start`,
    );
  }
  try {
    return await refreshOAuthState(path);
  } catch (error) {
    throw new Error(`${safeErrorMessage(error)} Run: hoplite mcp start`);
  }
}

function parseToolJson(result: unknown): JsonObject {
  const value = result as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = value.content?.find(item => item.type === 'text')?.text;
  if (!text) throw new Error('Hoplite MCP returned no JSON text payload');
  const parsed = JSON.parse(text) as JsonObject;
  if (value.isError) {
    throw new Error(`Hoplite MCP tool failed: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function withClient<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const oauth = await loadOAuthState();
  const transport = new StreamableHTTPClientTransport(new URL(oauth.resource), {
    requestInit: {
      headers: {
        Authorization: `${oauth.tokenType} ${oauth.accessToken}`,
      },
    },
  });
  const client = new Client(
    { name: 'hoplite-unofficial-toolkit', version: '0.1.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    return await work(client);
  } catch (error) {
    const message = safeErrorMessage(error);
    if (/token expired|401|unauthorized/i.test(message)) {
      throw new Error('Hoplite OAuth token expired. Run: hoplite mcp start');
    }
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function callTool(
  client: Client,
  name: string,
  args: JsonObject,
): Promise<JsonObject> {
  const result = await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: DEFAULT_TIMEOUT_MS, maxTotalTimeout: DEFAULT_TIMEOUT_MS },
  );
  return parseToolJson(result);
}

function validatedThreadId(value: string | undefined): string {
  if (!value || !THREAD_ID_RE.test(value)) {
    throw new Error('A valid Hoplite thread id is required');
  }
  return value;
}

function validatedOpaqueId(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`A valid Hoplite ${label} is required`);
  }
  return normalized;
}

function validatedClientOperationId(
  value: string | undefined,
  maximum = 128,
  required = false,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    if (required) throw new Error('An explicit --client-operation-id is required');
    return `codex-${Date.now()}-${crypto.randomUUID().slice(0, 12)}`;
  }
  if (normalized.length > maximum || /\s/.test(normalized)) {
    throw new Error(`client-operation-id must be ${maximum} characters or fewer and contain no whitespace`);
  }
  return normalized;
}

export function sanitizeOutput(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redactText(value).slice(0, 4_000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeOutput(item, depth + 1));
  if (!value || typeof value !== 'object') return null;

  const result: JsonObject = {};
  for (const [key, nested] of Object.entries(value as JsonObject).slice(0, 80)) {
    if (OUTPUT_SENSITIVE_KEY_RE.test(key)) {
      result[key] = '[redacted]';
      continue;
    }
    result[key] = sanitizeOutput(nested, depth + 1);
  }
  return result;
}

export function buildReadApiRequest(
  command: string,
  positionals: string[],
  flags: Map<string, string>,
): JsonObject {
  if (command === 'repositories') {
    return { method: 'GET', path: '/api/source-control/github/repositories' };
  }
  if (command === 'branches' || command === 'repo-inspect') {
    const repositoryId = validatedOpaqueId(positionals[0], 'repository id');
    const suffix = command === 'branches' ? 'branches' : 'inspect';
    return {
      method: 'GET',
      path: `/api/source-control/github/repositories/${encodeURIComponent(repositoryId)}/${suffix}`,
    };
  }
  if (command === 'project') {
    const projectId = validatedOpaqueId(positionals[0], 'project id');
    return { method: 'GET', path: `/api/projects/${encodeURIComponent(projectId)}` };
  }
  if (!THREAD_READ_COMMANDS.has(command)) throw new Error(`Unsupported read command: ${command}`);

  const threadId = validatedThreadId(positionals[0]);
  if (command === 'messages') {
    const query: JsonObject = {
      limit: parseBoundedInteger(flags.get('limit'), 100, 1, 500),
      activityLimit: parseBoundedInteger(flags.get('activity-limit'), 500, 0, 5_000),
    };
    if (flags.get('cursor')) query.cursor = validatedOpaqueId(flags.get('cursor'), 'message cursor');
    return { method: 'GET', path: `/api/threads/${threadId}/messages`, query };
  }

  const suffixByCommand: Record<string, string> = {
    'thread-capability': 'execution-capability',
    'thread-usage': 'usage',
    'thread-pr-status': 'pr/status',
    'thread-pr-comments': 'pr/comments',
    'thread-preview-checklist': 'preview-checklist',
  };
  return { method: 'GET', path: `/api/threads/${threadId}/${suffixByCommand[command]}` };
}

export function buildThreadActionRequest(
  command: string,
  positionals: string[],
  flags: Map<string, string>,
  allowlist = configuredMutationAllowlist(),
): JsonObject {
  if (!THREAD_ACTION_COMMANDS.has(command)) throw new Error(`Unsupported thread action: ${command}`);
  requireConfirmation(flags, 'POST');
  const threadId = validatedThreadId(positionals[0]);
  requireAllowlistedThread(threadId, allowlist);
  const clientOperationId = validatedClientOperationId(flags.get('client-operation-id'));
  const actionByCommand: Record<string, string> = {
    'thread-stop': 'stop',
    'thread-retry': 'retry',
    'thread-compact': 'compact',
    'thread-auto-title': 'title',
  };
  const body: JsonObject = { clientOperationId };
  if (command === 'thread-stop') {
    body.runId = validatedOpaqueId(flags.get('run-id'), 'run id');
  }
  return {
    action: command,
    threadId,
    clientOperationId,
    method: 'POST',
    path: `/api/threads/${threadId}/${actionByCommand[command]}`,
    body,
  };
}

export function createThreadBodyFromFlags(
  positionals: string[],
  flags: Map<string, string>,
): JsonObject {
  requireConfirmation(flags, 'POST');
  const projectId = validatedOpaqueId(positionals[0] ?? flags.get('project'), 'project id');
  const prompt = (flags.get('prompt') ?? flags.get('text') ?? positionals.slice(1).join(' ')).trim();
  if (!prompt) throw new Error('A non-empty thread prompt is required via --prompt, --text, or trailing arguments');
  if (prompt.length > 100_000) throw new Error('Thread prompt exceeds 100 KB');
  const clientOperationId = validatedClientOperationId(flags.get('client-operation-id'), 64, true);
  const body: JsonObject = { projectId, prompt, clientOperationId };
  const model = flags.get('model')?.trim();
  const title = flags.get('title')?.trim();
  if (model) {
    if (model.length > 1_024) throw new Error('Model id exceeds 1024 characters');
    body.model = model;
  }
  if (title) body.title = title.slice(0, 1_000);
  return body;
}

export function requireConfirmation(flags: Map<string, string>, method: string): void {
  if (method === 'GET' || method === 'HEAD') return;
  if (parseBoolean(flags.get('confirm'), false) !== true) {
    throw new Error(`Refusing ${method} API action without --confirm`);
  }
}

export function validateMutationPath(
  path: string,
  threadId?: string,
  allowlist = configuredMutationAllowlist(),
): string {
  if (!path.startsWith('/')) throw new Error('API path must be absolute and start with /');
  if (!path.startsWith('/api/')) throw new Error('API path must stay under /api/');
  const match = path.match(/^\/api\/threads\/(thr_[A-Za-z0-9]+)(?:\/|$)/);
  const pathThreadId = match?.[1];
  const selectedThreadId = threadId ? validatedThreadId(threadId) : pathThreadId;
  if (!selectedThreadId) throw new Error('API path must target a Hoplite thread');
  requireAllowlistedThread(selectedThreadId, allowlist);
  if (!pathThreadId) {
    throw new Error('API path must target an explicitly allowlisted Hoplite thread');
  }
  if (threadId && pathThreadId && threadId !== pathThreadId) {
    throw new Error('The --thread id does not match the thread id in --path');
  }
  return path;
}

function apiBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error('HOPLITE_API_BASE_URL must use HTTPS');
  }
  return parsed.origin;
}

function bodyFromFlags(flags: Map<string, string>): JsonObject | unknown[] | string | number | boolean | null | undefined {
  const inline = flags.get('body-json');
  const file = flags.get('body-file');
  if (inline && file) throw new Error('Use only one of --body-json or --body-file');
  if (!inline && !file) return undefined;
  const raw = inline ?? readFileSync(file!, 'utf8');
  if (raw.length > 100_000) throw new Error('Request body exceeds 100 KB');
  try {
    return JSON.parse(raw) as JsonObject | unknown[] | string | number | boolean | null;
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

export function messageTextFromFlags(
  positionals: string[],
  flags: Map<string, string>,
  allowlist = configuredMutationAllowlist(),
): string {
  const threadId = validatedThreadId(positionals[0]);
  requireAllowlistedThread(threadId, allowlist);
  const text = flags.get('text') ?? positionals.slice(1).join(' ');
  if (!text?.trim()) throw new Error('A non-empty message is required via --text or trailing arguments');
  if (text.length > 100_000) throw new Error('Message exceeds 100 KB');
  return text;
}

async function sendMessage(
  client: Client,
  positionals: string[],
  flags: Map<string, string>,
): Promise<JsonObject> {
  requireConfirmation(flags, 'POST');
  const threadId = validatedThreadId(positionals[0]);
  const content = messageTextFromFlags(positionals, flags);
  const clientOperationId = validatedClientOperationId(flags.get('client-operation-id'));
  const response = await callTool(client, 'hoplite_call_api', {
    method: 'POST',
    path: `/api/threads/${threadId}/messages`,
    body: { content, clientOperationId },
  });
  const body = response.body && typeof response.body === 'object'
    ? response.body as JsonObject
    : {};
  const message = body.message && typeof body.message === 'object' ? body.message as JsonObject : {};
  const run = body.run && typeof body.run === 'object' ? body.run as JsonObject : {};
  return {
    ok: response.ok === true,
    status: response.status ?? null,
    threadId,
    clientOperationId,
    messageId: typeof message.id === 'string' ? message.id : null,
    runId: typeof run.id === 'string' ? run.id : null,
    createdAt: typeof message.createdAt === 'string' ? message.createdAt : null,
  };
}

async function runReadApiCommand(
  client: Client,
  command: string,
  positionals: string[],
  flags: Map<string, string>,
): Promise<JsonObject> {
  const request = buildReadApiRequest(command, positionals, flags);
  const response = await callTool(client, 'hoplite_call_api', request);
  if (response.ok !== true || response.status !== 200) {
    throw new Error(`${command} request failed (HTTP ${String(response.status ?? 'unknown')})`);
  }
  return {
    checkedAt: new Date().toISOString(),
    method: request.method,
    path: request.path,
    status: response.status,
    body: sanitizeOutput(response.body ?? {}),
  };
}

async function runThreadAction(
  client: Client,
  command: string,
  positionals: string[],
  flags: Map<string, string>,
): Promise<JsonObject> {
  const request = buildThreadActionRequest(command, positionals, flags);
  const response = await callTool(client, 'hoplite_call_api', {
    method: request.method,
    path: request.path,
    body: request.body,
  });
  return {
    ok: response.ok === true,
    status: response.status ?? null,
    action: request.action,
    threadId: request.threadId,
    clientOperationId: request.clientOperationId,
    runId: command === 'thread-stop'
      ? ((request.body as JsonObject).runId ?? null)
      : null,
  };
}

async function createThread(
  client: Client,
  positionals: string[],
  flags: Map<string, string>,
): Promise<JsonObject> {
  const body = createThreadBodyFromFlags(positionals, flags);
  const response = await callTool(client, 'hoplite_call_api', {
    method: 'POST',
    path: '/api/threads',
    body,
  });
  const responseBody = response.body && typeof response.body === 'object'
    ? response.body as JsonObject
    : {};
  const thread = responseBody.thread && typeof responseBody.thread === 'object'
    ? responseBody.thread as JsonObject
    : responseBody;
  return {
    ok: response.ok === true,
    status: response.status ?? null,
    clientOperationId: body.clientOperationId,
    projectId: body.projectId,
    threadId: typeof thread.id === 'string' ? thread.id : null,
    createdAt: typeof thread.createdAt === 'string' ? thread.createdAt : null,
  };
}

export function summarizeApiResponse(raw: string, key: string): JsonObject {
  const safe = key.length >= 8 ? raw.split(key).join('[redacted]') : raw;
  let value: unknown = safe;
  for (let depth = 0; depth < 2 && typeof value === 'string'; depth += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  if (!value || typeof value !== 'object') {
    return { bodyType: typeof value, bodyLength: raw.length };
  }
  const object = value as JsonObject;
  const items = Array.isArray(object.items) ? object.items : undefined;
  const kindCounts: Record<string, number> = {};
  for (const item of items ?? []) {
    const kind = typeof item === 'object' && item && typeof (item as JsonObject).kind === 'string'
      ? String((item as JsonObject).kind)
      : 'unknown';
    kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
  }
  const summary: JsonObject = {
    ...(typeof object.ok === 'boolean' ? { ok: object.ok } : {}),
    ...(typeof object.status === 'string' ? { status: object.status } : {}),
    ...(typeof object.id === 'string' ? { id: object.id } : {}),
    ...(typeof object.threadId === 'string' ? { threadId: object.threadId } : {}),
    ...(typeof object.runId === 'string' ? { runId: object.runId } : {}),
    ...(typeof object.createdAt === 'string' ? { createdAt: object.createdAt } : {}),
    ...(typeof object.updatedAt === 'string' ? { updatedAt: object.updatedAt } : {}),
    ...(typeof object.hasMore === 'boolean' ? { hasMore: object.hasMore } : {}),
  };
  if (items) {
    summary.itemCount = items.length;
    summary.kindCounts = kindCounts;
  }
  if (typeof object.body === 'string') {
    summary.body = summarizeApiResponse(object.body, key);
  } else if (object.body && typeof object.body === 'object') {
    summary.bodyType = 'object';
  }
  if (Object.keys(summary).length === 0) {
    summary.bodyType = 'object';
    summary.bodyKeys = Object.keys(object).filter(keyName => !/content|prompt|token|secret|log|transcript|output/i.test(keyName)).slice(0, 40);
  }
  return summary;
}

async function directApiRequest(flags: Map<string, string>): Promise<JsonObject> {
  const method = (flags.get('method') || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
    throw new Error(`Unsupported API method: ${method}`);
  }
  requireConfirmation(flags, method);
  const path = validateMutationPath(flags.get('path') ?? '', flags.get('thread'));
  const body = bodyFromFlags(flags);
  if (['GET', 'HEAD', 'DELETE'].includes(method) && body !== undefined) {
    throw new Error(`${method} requests cannot include --body-json or --body-file`);
  }

  const credential = loadApiCredential();
  const key = credential.key;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
      const response = await fetch(`${apiBaseUrl(credential.baseUrl)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(credential.orgId ? { 'x-hoplite-org-id': credential.orgId } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      path,
      method,
      body: summarizeApiResponse(raw, key),
    };
  } finally {
    clearTimeout(timer);
  }
}

function compactMessage(message: TimelineMessage | undefined, limit = 1_400): JsonObject | null {
  if (!message) return null;
  return {
    role: message.role ?? null,
    at: message.createdAt ?? null,
    text: redactText(String(message.content ?? '')).slice(0, limit),
  };
}

function timelineMessages(body: JsonObject): TimelineMessage[] {
  const items = Array.isArray(body.items) ? body.items : [];
  return items
    .filter(item => {
      const row = item as JsonObject;
      const message = row.message as JsonObject | undefined;
      return row.kind === 'message' && typeof message?.content === 'string';
    })
    .map(item => (item as JsonObject).message as TimelineMessage);
}

export function summarizeTimeline(body: JsonObject, now = Date.now()): JsonObject {
  const messages = timelineMessages(body);
  const users = messages.filter(message => message.role === 'user');
  const assistants = messages.filter(message => message.role === 'assistant');
  const tools = messages.filter(message => message.role === 'tool');
  const latest = messages.at(-1);
  const latestAtMs = Date.parse(latest?.createdAt ?? '');

  return {
    itemCount: Array.isArray(body.items) ? body.items.length : 0,
    hasMore: body.hasMore === true,
    lastActivityAt: latest?.createdAt ?? null,
    lastActivityAgeSeconds: Number.isFinite(latestAtMs)
      ? Math.max(0, Math.floor((now - latestAtMs) / 1_000))
      : null,
    lastUser: compactMessage(users.at(-1), 600),
    lastAssistant: compactMessage(assistants.at(-1)),
    lastTool: compactMessage(tools.at(-1), 800),
  };
}

async function timeline(client: Client, threadId: string, limit: number): Promise<JsonObject> {
  const response = await callTool(client, 'hoplite_call_api', {
    method: 'GET',
    path: `/api/threads/${threadId}/timeline`,
    query: { limit },
  });
  if (response.ok !== true || response.status !== 200) {
    throw new Error(`Timeline request failed for ${threadId}`);
  }
  return (response.body ?? {}) as JsonObject;
}

async function listThreads(
  client: Client,
  flags: Map<string, string>,
  archivedDefault = false,
): Promise<JsonObject> {
  const status = flags.get('status');
  if (status && !ALLOWED_THREAD_STATUSES.has(status)) {
    throw new Error(`Unsupported thread status: ${status}`);
  }

  const args: JsonObject = {
    archived: parseBoolean(flags.get('archived'), archivedDefault),
    limit: parseBoundedInteger(flags.get('limit'), 100, 1, 100),
  };
  if (flags.get('project')) args.projectId = flags.get('project');
  if (flags.get('query')) args.query = flags.get('query');
  if (status) args.status = status;
  return callTool(client, 'hoplite_list_threads', args);
}

async function commandStatus(client: Client, flags: Map<string, string>): Promise<JsonObject> {
  const includeArchived = parseBoolean(flags.get('include-archived'), true);
  const active = await callTool(client, 'hoplite_list_threads', {
    archived: false,
    limit: 100,
  });
  const archived = includeArchived
    ? await callTool(client, 'hoplite_list_threads', { archived: true, limit: 100 })
    : { threads: [] };

  const rows: Array<JsonObject & { archived: boolean }> = [
    ...(Array.isArray(active.threads) ? active.threads : []).map(thread => ({
      ...(thread as JsonObject),
      archived: false,
    })),
    ...(Array.isArray(archived.threads) ? archived.threads : []).map(thread => ({
      ...(thread as JsonObject),
      archived: true,
    })),
  ];

  const limit = parseBoundedInteger(flags.get('timeline-limit'), 100, 1, 100);
  const scanned: JsonObject[] = [];
  for (const row of rows) {
    const threadId = validatedThreadId(String(row.id ?? ''));
    const body = await timeline(client, threadId, limit);
    scanned.push({
      id: threadId,
      title: row.title ?? null,
      status: row.status ?? null,
      archived: row.archived,
      updatedAt: row.updatedAt ?? null,
      evidence: summarizeTimeline(body),
    });
  }

  return {
    checkedAt: new Date().toISOString(),
    activeStatusCounts: active.statusCounts ?? {},
    activeCount: Array.isArray(active.threads) ? active.threads.length : 0,
    archivedCount: Array.isArray(archived.threads) ? archived.threads.length : 0,
    threads: scanned,
  };
}

function help(): JsonObject {
  return {
    name: 'hoplite-cli',
    mode: 'read_only_by_default',
    commands: {
      auth: 'Check OAuth presence, expiry, and permissions without printing tokens',
      projects: 'List authorized Hoplite projects',
      project: 'Read one project through the reviewed API',
      repositories: 'List GitHub repositories available to Hoplite',
      branches: 'List branches for one Hoplite repository id',
      'repo-inspect': 'Inspect inferred repository setup and preview settings',
      threads: 'List tasks; supports --archived, --status, --project, --query, --limit',
      'create-thread': 'Create a task through the reviewed API; requires an explicit idempotency key and --confirm',
      status: 'Scan active and archived tasks with bounded recent evidence',
      inspect: 'Inspect one task and its bounded recent timeline',
      messages: 'Read bounded messages for one task through the reviewed API',
      'thread-capability': 'Read execution capability for one task',
      'thread-usage': 'Read bounded usage metadata for one task',
      'thread-pr-status': 'Read pull-request status for one task',
      'thread-pr-comments': 'Read bounded pull-request comments for one task',
      'thread-preview-checklist': 'Read the preview verification checklist for one task',
      'thread-stop': 'Stop one explicit run on an allowlisted task; requires --run-id and --confirm',
      'thread-retry': 'Retry an allowlisted task; requires --confirm',
      'thread-compact': 'Compact an allowlisted task context; requires --confirm',
      'thread-auto-title': 'Regenerate an allowlisted task title; requires --confirm',
      models: 'List current Hoplite model providers',
      tools: 'List live Hoplite MCP tool schemas',
      api: 'Call one explicitly supplied API route for one allowlisted thread; direct API mutations require HOPLITE_API_KEY and --confirm',
      'api-auth': 'Check whether HOPLITE_API_KEY is present without printing it',
      message: 'Send a message to one allowlisted existing thread through the authenticated MCP session; requires --confirm',
    },
    apiAuth: 'Set HOPLITE_API_KEY in the environment; never put keys in source, prompts, or logs',
    mutationAllowlist: 'Set HOPLITE_MUTATION_ALLOWLIST to a comma-separated list of thread ids; mutations are disabled when empty',
    recovery: 'Run `hoplite mcp start` when OAuth is missing or expired',
  };
}

export async function run(argv: string[]): Promise<JsonObject> {
  const parsed = parseCliArgs(argv);
  if (parsed.command === 'help' || parsed.command === '--help' || parsed.command === '-h') {
    return help();
  }
  if (parsed.command === 'auth') return authSummary();
  if (parsed.command === 'api-auth') return apiKeySummary();

  if (parsed.command === 'api') return directApiRequest(parsed.flags);

  return withClient(async client => {
    switch (parsed.command) {
      case 'message':
        return sendMessage(client, parsed.positionals, parsed.flags);
      case 'create-thread':
        return createThread(client, parsed.positionals, parsed.flags);
      case 'repositories':
      case 'branches':
      case 'repo-inspect':
      case 'project':
      case 'messages':
      case 'thread-capability':
      case 'thread-usage':
      case 'thread-pr-status':
      case 'thread-pr-comments':
      case 'thread-preview-checklist':
        return runReadApiCommand(client, parsed.command, parsed.positionals, parsed.flags);
      case 'thread-stop':
      case 'thread-retry':
      case 'thread-compact':
      case 'thread-auto-title':
        return runThreadAction(client, parsed.command, parsed.positionals, parsed.flags);
      case 'projects':
        return callTool(client, 'hoplite_list_projects', {});
      case 'threads':
        return listThreads(client, parsed.flags);
      case 'status':
        return commandStatus(client, parsed.flags);
      case 'inspect': {
        const threadId = validatedThreadId(parsed.positionals[0]);
        const limit = parseBoundedInteger(parsed.flags.get('limit'), 100, 1, 100);
        const thread = await callTool(client, 'hoplite_get_thread', { threadId });
        const body = await timeline(client, threadId, limit);
        const messages = timelineMessages(body).slice(-12).map(message => compactMessage(message, 1_200));
        return {
          checkedAt: new Date().toISOString(),
          thread: thread.thread ?? thread,
          timeline: {
            ...summarizeTimeline(body),
            recentMessages: messages,
          },
        };
      }
      case 'models':
        return callTool(client, 'hoplite_call_api', {
          method: 'GET',
          path: '/api/model-providers',
        });
      case 'tools': {
        const listed = await client.listTools(undefined, {
          timeout: DEFAULT_TIMEOUT_MS,
          maxTotalTimeout: DEFAULT_TIMEOUT_MS,
        });
        return {
          tools: listed.tools.map(tool => ({
            name: tool.name,
            description: tool.description ?? null,
            inputSchema: tool.inputSchema,
          })),
        };
      }
      default:
        throw new Error(`Unknown command: ${parsed.command}`);
    }
  });
}

if (import.meta.main) {
  run(process.argv.slice(2))
    .then(result => {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    })
    .catch(error => {
      console.error(JSON.stringify({ ok: false, error: safeErrorMessage(error) }, null, 2));
      process.exitCode = 1;
    });
}
