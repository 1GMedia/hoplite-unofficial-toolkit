import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type {
  CliCommandDefinition,
  CommandResult,
  LocalCommandContext,
  McpCommandContext,
} from './command-registry';

type JsonObject = Record<string, unknown>;

type ApiOutcome =
  | 'unsupported_credential'
  | 'subscription_required'
  | 'role_denied'
  | 'absent_or_unavailable'
  | 'deployment_unavailable'
  | 'request_failed'
  | 'schema_drift';

type ApiReadResult =
  | { ok: true; status: 200; body: JsonObject }
  | { ok: false; status: number | null; outcome: ApiOutcome };

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_CONNECTIONS = 100;
const MAX_MODELS_PER_CONNECTION = 200;
const MAX_INPUT_STRING_LENGTH = 512;
const MAX_OUTPUT_STRING_LENGTH = 160;
const MAX_TOOL_RESPONSE_BYTES = 2 * 1024 * 1024;
const REDACTED_LABEL = '[redacted]';

// Remote connection and model labels are untrusted display data. Keep the
// pass-through grammar intentionally small and redact anything that resembles
// a credential name, provider token, URL, authorization value, or opaque
// high-entropy value. A missed label is less costly than printing a secret.
const SAFE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/()+-]*$/;
const CREDENTIAL_KEY_RE = /(?:access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|api[_-]?key|private[_-]?key|authorization|password|passwd|token|secret|credential)/i;
const AUTHORIZATION_VALUE_RE = /(?:^|\s)(?:bearer|basic)\s+/i;
const URL_LIKE_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;
const GENERIC_DELIMITED_KEY_RE = /(?:^|[^A-Za-z0-9])[A-Za-z0-9]+[_-]key(?=[^A-Za-z0-9]|$)/i;
const GENERIC_CAMEL_KEY_RE = /(?:^|[^A-Za-z0-9])[a-z0-9][A-Za-z0-9]*Key(?=[^A-Za-z0-9]|$)/;
const BARE_DOMAIN_RE = /(?:^|\s)(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}(?::\d{1,5})?(?:\/[^\s]*)?(?:$|\s)/i;
const IPV4_PATH_RE = /(?:^|\s)(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/[^\s]*)?(?:$|\s)/;
const PROVIDER_CREDENTIAL_RES = [
  /(?:^|[^A-Za-z0-9])sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{6,}(?:$|[^A-Za-z0-9])/i,
  /(?:^|[^A-Za-z0-9])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{6,}(?:$|[^A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{6,}(?:$|[^A-Za-z0-9])/i,
  /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{12,}(?:$|[^A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{20,}(?:$|[^A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{6,}(?:$|[^A-Za-z0-9])/i,
  /(?:^|[^A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{6,}(?:$|[^A-Za-z0-9])/i,
  /(?:^|[^A-Za-z0-9])(?:whsec_|hf_|npm_)[A-Za-z0-9_-]{6,}(?:$|[^A-Za-z0-9])/i,
  /(?:^|[^A-Za-z0-9])glpat-[A-Za-z0-9_-]{6,}(?:$|[^A-Za-z0-9])/i,
  /(?:^|[^A-Za-z0-9])(?:pypi-|ya29\.)[A-Za-z0-9_-]{10,}(?:$|[^A-Za-z0-9])/i,
  /(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9])/,
] as const;
const OPAQUE_HEX_RE = /[A-Fa-f0-9]{20,}/;
const OPAQUE_ALNUM_RE = /[A-Za-z0-9]{24,}/;
const OPAQUE_MIXED_RUN_RE = /[A-Za-z0-9_-]{24,}/g;

const WORKSPACE_DEFAULT_ROUTES = [
  ['publicMediaSharing', '/api/orgs/public-media-sharing'],
  ['agentComplaintReporting', '/api/orgs/agent-complaint-reporting'],
  ['agentTaskSystem', '/api/orgs/agent-task-system'],
  ['prReviewAutofixDefault', '/api/orgs/pr-review-autofix-default'],
  ['prReviewAutoMergeDefault', '/api/orgs/pr-review-auto-merge-default'],
  ['autoArchiveMergedThreads', '/api/orgs/auto-archive-merged-threads'],
] as const;

const SANDBOX_SPEC_KEYS = [
  'defaultCpu',
  'defaultMemoryGiB',
  'maxCpu',
  'maxDiskGiB',
  'maxMemoryGiB',
  'staffMaxCpu',
  'staffMaxDiskGiB',
  'staffMaxMemoryGiB',
  'runtimeProfile',
] as const;

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter(key => !allowedSet.has(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unexpected fields`);
}

function validateInvocation(context: LocalCommandContext): void {
  if (context.positionals.length > 0) throw new Error('This command does not accept positional arguments');
  if (context.flags.size > 0) throw new Error('This command does not accept flags');
}

function containsOpaqueValue(value: string): boolean {
  if (OPAQUE_HEX_RE.test(value) || OPAQUE_ALNUM_RE.test(value)) return true;
  const mixedRuns = value.match(OPAQUE_MIXED_RUN_RE) ?? [];
  return mixedRuns.some(run => /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run));
}

function outcomeForStatus(status: number | null): ApiOutcome {
  return {
    401: 'unsupported_credential',
    402: 'subscription_required',
    403: 'role_denied',
    404: 'absent_or_unavailable',
    501: 'deployment_unavailable',
  }[String(status)] as ApiOutcome | undefined ?? 'request_failed';
}

function parseToolPayload(result: unknown): JsonObject | null {
  if (!isRecord(result)) return null;
  try {
    requireExactKeys(result, ['content', 'isError'], 'MCP result');
  } catch {
    return null;
  }
  if (
    !Object.hasOwn(result, 'content')
    || !Object.hasOwn(result, 'isError')
    || typeof result.isError !== 'boolean'
    || result.isError
    || !Array.isArray(result.content)
    || result.content.length !== 1
  ) return null;
  const block = result.content[0];
  if (!isRecord(block)) return null;
  try {
    requireExactKeys(block, ['type', 'text'], 'MCP text content');
  } catch {
    return null;
  }
  if (
    !Object.hasOwn(block, 'type')
    || !Object.hasOwn(block, 'text')
    || block.type !== 'text'
    || typeof block.text !== 'string'
  ) return null;
  if (new TextEncoder().encode(block.text).byteLength > MAX_TOOL_RESPONSE_BYTES) return null;
  try {
    const parsed = JSON.parse(block.text) as unknown;
    if (!isRecord(parsed)) return null;
    requireExactKeys(parsed, ['ok', 'status', 'body'], 'API result');
    if (
      !Object.hasOwn(parsed, 'ok')
      || !Object.hasOwn(parsed, 'status')
      || !Object.hasOwn(parsed, 'body')
      || typeof parsed.ok !== 'boolean'
      || !Number.isInteger(parsed.status)
      || (parsed.status as number) < 100
      || (parsed.status as number) > 599
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readApi(client: Client, path: string): Promise<ApiReadResult> {
  let result: unknown;
  try {
    result = await client.callTool(
      { name: 'hoplite_call_api', arguments: { method: 'GET', path } },
      undefined,
      { timeout: REQUEST_TIMEOUT_MS, maxTotalTimeout: REQUEST_TIMEOUT_MS },
    );
  } catch {
    return { ok: false, status: null, outcome: 'request_failed' };
  }

  const payload = parseToolPayload(result);
  if (!payload) return { ok: false, status: null, outcome: 'request_failed' };
  const status = Number.isInteger(payload.status) ? payload.status as number : null;
  if (status === 200) {
    if (payload.ok !== true || !isRecord(payload.body)) {
      return { ok: false, status, outcome: 'schema_drift' };
    }
    return { ok: true, status, body: payload.body };
  }
  if (payload.ok !== false) return { ok: false, status, outcome: 'request_failed' };
  return { ok: false, status, outcome: outcomeForStatus(status) };
}

function schemaDrift(path: string): CommandResult {
  return { ok: false, path, status: 200, outcome: 'schema_drift' };
}

function projectFailure(path: string, result: Exclude<ApiReadResult, { ok: true }>): CommandResult {
  return { ok: false, path, status: result.status, outcome: result.outcome };
}

function boundedRemoteString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_INPUT_STRING_LENGTH) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function safeProjectedLabel(value: unknown, label: string): string {
  const raw = boundedRemoteString(value, label);
  const projected = raw.replace(/\s+/g, ' ').trim();
  if (
    projected.length === 0
    || projected.length > MAX_OUTPUT_STRING_LENGTH
    || !SAFE_LABEL_RE.test(projected)
    || CREDENTIAL_KEY_RE.test(projected)
    || GENERIC_DELIMITED_KEY_RE.test(projected)
    || GENERIC_CAMEL_KEY_RE.test(projected)
    || AUTHORIZATION_VALUE_RE.test(projected)
    || URL_LIKE_RE.test(projected)
    || BARE_DOMAIN_RE.test(projected)
    || IPV4_PATH_RE.test(projected)
    || containsOpaqueValue(projected)
    || PROVIDER_CREDENTIAL_RES.some(pattern => pattern.test(projected))
  ) return REDACTED_LABEL;
  return projected;
}

function positiveIntegerOrNull(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer or null`);
  }
  return value as number;
}

function validIsoDatetime(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || value.length > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} must be an ISO datetime`);
  }
  return value;
}

async function workspaceDefaultsGet(context: McpCommandContext): Promise<CommandResult> {
  validateInvocation(context);
  const entries = await Promise.all(WORKSPACE_DEFAULT_ROUTES.map(async ([key, path]) => {
    const result = await readApi(context.client, path);
    if (!result.ok) return [key, projectFailure(path, result)] as const;
    try {
      requireExactKeys(result.body, ['ok', 'enabled'], 'Workspace default response');
      if (result.body.ok !== true || typeof result.body.enabled !== 'boolean') throw new Error('invalid response');
      return [key, { ok: true, path, status: 200, enabled: result.body.enabled }] as const;
    } catch {
      return [key, schemaDrift(path)] as const;
    }
  }));
  const defaults = Object.fromEntries(entries) as Record<string, CommandResult>;
  return {
    ok: Object.values(defaults).every(entry => entry.ok === true),
    checkedAt: new Date().toISOString(),
    defaults,
  };
}

async function workspaceSandboxDefaultGet(context: McpCommandContext): Promise<CommandResult> {
  validateInvocation(context);
  const path = '/api/orgs/sandbox-spec';
  const result = await readApi(context.client, path);
  if (!result.ok) return projectFailure(path, result);
  try {
    requireExactKeys(result.body, ['ok', 'spec', 'staffCeilings'], 'Sandbox response');
    if (result.body.ok !== true || (result.body.spec !== null && !isRecord(result.body.spec))) {
      throw new Error('invalid sandbox response');
    }
    const rawSpec = result.body.spec as JsonObject | null;
    if (rawSpec) requireExactKeys(rawSpec, SANDBOX_SPEC_KEYS, 'Sandbox spec');
    const spec = rawSpec === null
      ? null
      : {
        ...Object.fromEntries(SANDBOX_SPEC_KEYS
          .filter(key => key !== 'runtimeProfile')
          .map(key => [
            key,
            positiveIntegerOrNull(rawSpec[key], `Sandbox ${key}`),
          ])),
        runtimeProfile: (() => {
          const value = rawSpec.runtimeProfile;
          if (value === undefined || value === null) return null;
          if (value !== 'docker-compose') throw new Error('Unsupported sandbox runtimeProfile');
          return value;
        })(),
      };
    let staffCeilings: { maxCpu: number | null; maxMemoryGiB: number | null } | null = null;
    if (result.body.staffCeilings !== undefined) {
      if (!isRecord(result.body.staffCeilings)) throw new Error('invalid staff ceilings');
      requireExactKeys(result.body.staffCeilings, ['maxCpu', 'maxMemoryGiB'], 'Sandbox staff ceilings');
      staffCeilings = {
        maxCpu: positiveIntegerOrNull(result.body.staffCeilings.maxCpu, 'Staff maxCpu'),
        maxMemoryGiB: positiveIntegerOrNull(result.body.staffCeilings.maxMemoryGiB, 'Staff maxMemoryGiB'),
      };
    }
    return { ok: true, path, status: 200, configured: spec !== null, spec, staffCeilings };
  } catch {
    return schemaDrift(path);
  }
}

async function workspaceModelKeysStatus(context: McpCommandContext): Promise<CommandResult> {
  validateInvocation(context);
  const path = '/api/orgs/model-keys';
  const result = await readApi(context.client, path);
  if (!result.ok) return projectFailure(path, result);
  try {
    requireExactKeys(result.body, ['ok', 'providers'], 'Model-key response');
    if (result.body.ok !== true || !Array.isArray(result.body.providers)) throw new Error('invalid providers');
    const providers = result.body.providers;
    if (providers.length > 2 || providers.some(provider => provider !== 'anthropic' && provider !== 'openai')) {
      throw new Error('unsupported provider');
    }
    if (new Set(providers).size !== providers.length) throw new Error('duplicate provider');
    return {
      ok: true,
      path,
      status: 200,
      providers: ['anthropic', 'openai'].map(provider => ({
        provider,
        configured: providers.includes(provider),
      })),
    };
  } catch {
    return schemaDrift(path);
  }
}

async function workspaceModelConnectionsList(context: McpCommandContext): Promise<CommandResult> {
  validateInvocation(context);
  const path = '/api/model-connections';
  const result = await readApi(context.client, path);
  if (!result.ok) return projectFailure(path, result);
  try {
    requireExactKeys(result.body, ['ok', 'connections'], 'Model-connections response');
    if (result.body.ok !== true || !Array.isArray(result.body.connections)) throw new Error('invalid connections');
    if (result.body.connections.length > MAX_CONNECTIONS) throw new Error('too many connections');
    const connectionKinds = new Set([
      'neon-ai-gateway',
      'openrouter',
      'vercel-ai-gateway',
      'cloudflare-ai-gateway',
    ]);
    const statuses = new Set(['active', 'disabled', 'error']);
    const transports = new Set(['chat-completions', 'responses']);
    const seenConnectionIds = new Set<string>();
    const connections = result.body.connections.map((raw, connectionIndex) => {
      if (!isRecord(raw)) throw new Error('connection must be an object');
      requireExactKeys(raw, [
        'id', 'kind', 'name', 'status', 'version', 'lastVerifiedAt', 'lastError', 'models',
      ], 'Model connection');
      if (
        typeof raw.kind !== 'string'
        || typeof raw.status !== 'string'
        || !connectionKinds.has(raw.kind)
        || !statuses.has(raw.status)
      ) {
        throw new Error('unsupported connection enum');
      }
      if (!Number.isSafeInteger(raw.version) || (raw.version as number) <= 0) throw new Error('invalid version');
      if (raw.lastVerifiedAt !== null) validIsoDatetime(raw.lastVerifiedAt, 'lastVerifiedAt');
      if (
        raw.lastError !== null
        && (typeof raw.lastError !== 'string' || raw.lastError.length > 4_096)
      ) throw new Error('invalid lastError');
      if (!Array.isArray(raw.models) || raw.models.length > MAX_MODELS_PER_CONNECTION) {
        throw new Error('invalid model collection');
      }
      const rawId = boundedRemoteString(raw.id, 'Connection id');
      if (seenConnectionIds.has(rawId)) throw new Error('duplicate connection id');
      seenConnectionIds.add(rawId);
      const id = safeProjectedLabel(rawId, 'Connection id');
      const seenModelIds = new Set<string>();
      const models = raw.models.map((model, modelIndex) => {
        if (!isRecord(model)) throw new Error('model must be an object');
        requireExactKeys(model, ['id', 'name', 'transport', 'verified'], 'Connection model');
        if (
          typeof model.transport !== 'string'
          || !transports.has(model.transport)
          || typeof model.verified !== 'boolean'
        ) {
          throw new Error('invalid model enum');
        }
        const rawModelId = boundedRemoteString(model.id, `Connection ${connectionIndex} model ${modelIndex} id`);
        if (seenModelIds.has(rawModelId)) throw new Error('duplicate model id');
        seenModelIds.add(rawModelId);
        return {
          id: safeProjectedLabel(rawModelId, `Connection ${connectionIndex} model ${modelIndex} id`),
          name: safeProjectedLabel(model.name, `Connection ${connectionIndex} model ${modelIndex} name`),
          transport: model.transport,
          verified: model.verified,
        };
      });
      return {
        id,
        kind: raw.kind,
        name: safeProjectedLabel(raw.name, `Connection ${connectionIndex} name`),
        status: raw.status,
        version: raw.version,
        lastVerifiedAt: raw.lastVerifiedAt,
        hasLastError: typeof raw.lastError === 'string' && raw.lastError.length > 0,
        models,
      };
    });
    return { ok: true, path, status: 200, count: connections.length, connections };
  } catch {
    return schemaDrift(path);
  }
}

export const workspaceSettingsCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'workspace-defaults-get',
    description: 'Read six verified workspace boolean defaults with per-route availability',
    transport: 'mcp',
    validate: context => validateInvocation(context),
    run: workspaceDefaultsGet,
  },
  {
    name: 'workspace-sandbox-default-get',
    description: 'Read the workspace sandbox default and staff ceilings without changing them',
    transport: 'mcp',
    validate: context => validateInvocation(context),
    run: workspaceSandboxDefaultGet,
  },
  {
    name: 'workspace-model-keys-status',
    description: 'Report Anthropic/OpenAI workspace key presence without reading key values',
    transport: 'mcp',
    validate: context => validateInvocation(context),
    run: workspaceModelKeysStatus,
  },
  {
    name: 'workspace-model-connections-list',
    description: 'List bounded model-connection metadata without credentials or provider errors',
    transport: 'mcp',
    validate: context => validateInvocation(context),
    run: workspaceModelConnectionsList,
  },
];
