import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type {
  CliCommandDefinition,
  CommandResult,
  LocalCommandContext,
  McpCommandContext,
} from './command-registry';

type JsonObject = Record<string, unknown>;

type ReadOutcome =
  | 'unsupported_credential'
  | 'subscription_required'
  | 'role_denied'
  | 'absent_or_unavailable'
  | 'deployment_unavailable'
  | 'request_failed'
  | 'schema_drift';

type ApiReadResult =
  | { ok: true; status: 200; body: JsonObject }
  | { ok: false; status: number | null; outcome: ReadOutcome };

type AutomationProjection = {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  triggerKind: 'schedule' | 'webhook';
  schedule: null | {
    mode: 'cron' | 'interval';
    timezone?: string;
    intervalMinutes?: number;
  };
  hasTitle: boolean;
  hasSpendLimit: boolean;
  webhookCredentialConfigured: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_TOOL_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_AUTOMATIONS = 100;
const MAX_EXECUTIONS = 100;
const DEFAULT_EXECUTION_LIMIT = 25;
const MAX_REMOTE_PROMPT_LENGTH = 100_000;
const MAX_PRIVATE_ERROR_LENGTH = 4_096;
const MAX_OPAQUE_STRING_LENGTH = 512;
const REDACTED_LABEL = '[redacted]';

const RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/()+-]*$/;
const SENSITIVE_LABEL_RE = /(?:access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|api[_-]?key|private[_-]?key|authorization|password|passwd|token|secret|credential)/i;
const GENERIC_DELIMITED_KEY_RE = /(?:^|[^A-Za-z0-9])[A-Za-z0-9]+[_-]key(?=[^A-Za-z0-9]|$)/i;
const GENERIC_CAMEL_KEY_RE = /(?:^|[^A-Za-z0-9])[a-z0-9][A-Za-z0-9]*Key(?=[^A-Za-z0-9]|$)/;
const AUTHORIZATION_VALUE_RE = /(?:^|\s)(?:bearer|basic)\s+/i;
const URL_LIKE_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;
const BARE_DOMAIN_RE = /(?:^|\s)(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}(?::\d{1,5})?(?:\/[^\s]*)?(?:$|\s)/i;
const IPV4_PATH_RE = /(?:^|\s)(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/[^\s]*)?(?:$|\s)/;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const OPAQUE_HEX_RE = /[A-Fa-f0-9]{20,}/;
const OPAQUE_ALNUM_RE = /[A-Za-z0-9]{24,}/;
const OPAQUE_MIXED_RUN_RE = /[A-Za-z0-9_-]{24,}/g;
const PROVIDER_CREDENTIAL_RES = [
  /(?:^|[^A-Za-z0-9])sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{6,}(?:$|[^A-Za-z0-9])/i,
  /(?:^|[^A-Za-z0-9])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{6,}(?:$|[^A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{6,}(?:$|[^A-Za-z0-9])/i,
  /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{12,}(?:$|[^A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{6,}(?:$|[^A-Za-z0-9])/i,
] as const;

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some(key => !allowedSet.has(key))) {
    throw new Error(`${label} contains unexpected fields`);
  }
}

function validatedResourceId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RESOURCE_ID_RE.test(value)) {
    throw new Error(`${label} must be a bounded resource id`);
  }
  return value;
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string'
    || value.length > maximum
    || (!allowEmpty && value.length === 0)
  ) throw new Error(`${label} must be a bounded string`);
  return value;
}

function nullableBoundedString(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null) return null;
  return boundedString(value, label, maximum, true);
}

function validDatetimeOrNull(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  const datetime = boundedString(value, label, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(datetime)
    || !Number.isFinite(Date.parse(datetime))
  ) throw new Error(`${label} must be an ISO datetime`);
  return datetime;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return value as number;
}

function containsOpaqueValue(value: string): boolean {
  if (OPAQUE_HEX_RE.test(value) || OPAQUE_ALNUM_RE.test(value)) return true;
  const mixedRuns = value.match(OPAQUE_MIXED_RUN_RE) ?? [];
  return mixedRuns.some(run => /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run));
}

function safeProjectedLabel(value: unknown, label: string): string {
  const raw = boundedString(value, label, 120);
  const projected = raw.replace(/\s+/g, ' ').trim();
  if (
    projected.length === 0
    || !SAFE_LABEL_RE.test(projected)
    || SENSITIVE_LABEL_RE.test(projected)
    || GENERIC_DELIMITED_KEY_RE.test(projected)
    || GENERIC_CAMEL_KEY_RE.test(projected)
    || AUTHORIZATION_VALUE_RE.test(projected)
    || URL_LIKE_RE.test(projected)
    || BARE_DOMAIN_RE.test(projected)
    || IPV4_PATH_RE.test(projected)
    || EMAIL_RE.test(projected)
    || containsOpaqueValue(projected)
    || PROVIDER_CREDENTIAL_RES.some(pattern => pattern.test(projected))
  ) return REDACTED_LABEL;
  return projected;
}

function validCronField(field: string, minimum: number, maximum: number): boolean {
  if (!field) return false;
  for (const segment of field.split(',')) {
    const stepParts = segment.split('/');
    if (stepParts.length !== 1 && stepParts.length !== 2) return false;
    const [base, rawStep] = stepParts;
    if (!base || rawStep === '') return false;
    if (rawStep !== undefined) {
      const step = Number(rawStep);
      if (!Number.isInteger(step) || step < 1) return false;
    }
    if (base === '*') continue;
    if (base.includes('-')) {
      const range = base.split('-');
      if (range.length !== 2) return false;
      const start = Number(range[0]);
      const end = Number(range[1]);
      if (
        !Number.isInteger(start)
        || !Number.isInteger(end)
        || start < minimum
        || end > maximum
        || start > end
      ) return false;
      continue;
    }
    const numeric = Number(base);
    if (!Number.isInteger(numeric) || numeric < minimum || numeric > maximum) return false;
  }
  return true;
}

function validCronExpression(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5
    && validCronField(fields[0]!, 0, 59)
    && validCronField(fields[1]!, 0, 23)
    && validCronField(fields[2]!, 1, 31)
    && validCronField(fields[3]!, 1, 12)
    && validCronField(fields[4]!, 0, 7);
}

function parseSchedule(value: unknown, label: string): AutomationProjection['schedule'] {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || typeof value.mode !== 'string') throw new Error(`${label} is invalid`);
  if (value.mode === 'cron') {
    requireExactKeys(value, ['mode', 'expression', 'timezone'], label);
    const expression = boundedString(value.expression, `${label} expression`, 256);
    if (!validCronExpression(expression)) throw new Error(`${label} expression is invalid`);
    const timezone = boundedString(value.timezone, `${label} timezone`, 128);
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw new Error(`${label} timezone is invalid`);
    }
    return { mode: 'cron', timezone };
  }
  if (value.mode === 'interval') {
    requireExactKeys(value, ['mode', 'intervalMs'], label);
    const intervalMs = nonnegativeInteger(value.intervalMs, `${label} intervalMs`);
    if (intervalMs < 60_000) throw new Error(`${label} intervalMs is below one minute`);
    return { mode: 'interval', intervalMinutes: intervalMs / 60_000 };
  }
  throw new Error(`${label} mode is unsupported`);
}

function projectAutomation(
  value: unknown,
  requestedProjectId: string,
  index: number,
): AutomationProjection {
  if (!isRecord(value)) throw new Error('Automation must be an object');
  requireExactKeys(value, [
    'id',
    'projectId',
    'name',
    'enabled',
    'triggerKind',
    'schedule',
    'prompt',
    'title',
    'maxSpendPerThreadMicros',
    'webhookTokenPrefix',
    'nextRunAt',
    'lastRunAt',
    'createdAt',
    'updatedAt',
  ], 'Automation');
  const id = validatedResourceId(value.id, `Automation ${index} id`);
  const projectId = validatedResourceId(value.projectId, `Automation ${index} projectId`);
  if (projectId !== requestedProjectId) throw new Error('Automation project does not match the request');
  if (typeof value.enabled !== 'boolean') throw new Error('Automation enabled must be boolean');
  if (value.triggerKind !== 'schedule' && value.triggerKind !== 'webhook') {
    throw new Error('Automation triggerKind is unsupported');
  }
  boundedString(value.prompt, `Automation ${index} prompt`, MAX_REMOTE_PROMPT_LENGTH, true);
  const title = nullableBoundedString(value.title, `Automation ${index} title`, 160);
  const spendLimit = value.maxSpendPerThreadMicros;
  if (
    spendLimit !== undefined
    && spendLimit !== null
    && (!Number.isSafeInteger(spendLimit) || (spendLimit as number) <= 0)
  ) throw new Error('Automation maxSpendPerThreadMicros is invalid');
  const webhookTokenPrefix = nullableBoundedString(
    value.webhookTokenPrefix,
    `Automation ${index} webhookTokenPrefix`,
    16,
  );
  return {
    id,
    projectId,
    name: safeProjectedLabel(value.name, `Automation ${index} name`),
    enabled: value.enabled,
    triggerKind: value.triggerKind,
    schedule: parseSchedule(value.schedule, `Automation ${index} schedule`),
    hasTitle: Boolean(title),
    hasSpendLimit: spendLimit !== undefined && spendLimit !== null,
    webhookCredentialConfigured: Boolean(webhookTokenPrefix),
    nextRunAt: validDatetimeOrNull(value.nextRunAt, `Automation ${index} nextRunAt`),
    lastRunAt: validDatetimeOrNull(value.lastRunAt, `Automation ${index} lastRunAt`),
    createdAt: validDatetimeOrNull(value.createdAt, `Automation ${index} createdAt`),
    updatedAt: validDatetimeOrNull(value.updatedAt, `Automation ${index} updatedAt`),
  };
}

function parseAutomationList(body: JsonObject, projectId: string): AutomationProjection[] {
  requireExactKeys(body, ['ok', 'automations'], 'Automation-list response');
  if (body.ok !== true || !Array.isArray(body.automations) || body.automations.length > MAX_AUTOMATIONS) {
    throw new Error('Automation-list response is invalid');
  }
  const automations = body.automations.map((value, index) => projectAutomation(value, projectId, index));
  if (new Set(automations.map(automation => automation.id)).size !== automations.length) {
    throw new Error('Automation-list response contains duplicate ids');
  }
  return automations;
}

function outcomeForStatus(status: number | null): ReadOutcome {
  return {
    401: 'unsupported_credential',
    402: 'subscription_required',
    403: 'role_denied',
    404: 'absent_or_unavailable',
    501: 'deployment_unavailable',
  }[String(status)] as ReadOutcome | undefined ?? 'request_failed';
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
    || result.isError !== false
    || !Array.isArray(result.content)
    || result.content.length !== 1
  ) return null;
  const block = result.content[0];
  if (!isRecord(block)) return null;
  try {
    requireExactKeys(block, ['type', 'text'], 'MCP text block');
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
    requireExactKeys(parsed, ['ok', 'status', 'body'], 'API envelope');
    if (
      typeof parsed.ok !== 'boolean'
      || !Number.isInteger(parsed.status)
      || (parsed.status as number) < 100
      || (parsed.status as number) > 599
      || !Object.hasOwn(parsed, 'body')
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
  const status = payload.status as number;
  if (status === 200) {
    if (payload.ok !== true || !isRecord(payload.body)) {
      return { ok: false, status, outcome: 'schema_drift' };
    }
    return { ok: true, status, body: payload.body };
  }
  if (payload.ok !== false) return { ok: false, status, outcome: 'request_failed' };
  return { ok: false, status, outcome: outcomeForStatus(status) };
}

function failure(path: string, result: Exclude<ApiReadResult, { ok: true }>): CommandResult {
  return { ok: false, path, status: result.status, outcome: result.outcome };
}

function schemaDrift(path: string): CommandResult {
  return { ok: false, path, status: 200, outcome: 'schema_drift' };
}

function requireInvocation(
  context: LocalCommandContext,
  positionalCount: number,
  allowedFlags: readonly string[],
  usage: string,
): void {
  if (context.positionals.length !== positionalCount) throw new Error(`Usage: ${usage}`);
  const allowed = new Set(allowedFlags);
  if ([...context.flags.keys()].some(flag => !allowed.has(flag))) {
    throw new Error(`Unsupported flag for ${usage.split(' ')[0]}`);
  }
}

function listInvocation(context: LocalCommandContext): { projectId: string } {
  requireInvocation(context, 1, [], 'project-automations-list <project-id>');
  return { projectId: validatedResourceId(context.positionals[0], 'Project id') };
}

function detailInvocation(context: LocalCommandContext): { projectId: string; automationId: string } {
  requireInvocation(context, 2, [], 'project-automation-get <project-id> <automation-id>');
  return {
    projectId: validatedResourceId(context.positionals[0], 'Project id'),
    automationId: validatedResourceId(context.positionals[1], 'Automation id'),
  };
}

function statusInvocation(context: LocalCommandContext): { projectId: string } {
  requireInvocation(context, 1, [], 'project-automations-status <project-id>');
  return { projectId: validatedResourceId(context.positionals[0], 'Project id') };
}

function runsInvocation(context: LocalCommandContext): {
  projectId: string;
  automationId: string;
  limit: number;
} {
  requireInvocation(context, 2, ['limit'], 'project-automation-runs-list <project-id> <automation-id> [--limit 1..100]');
  const rawLimit = context.flags.get('limit');
  const limit = rawLimit === undefined ? DEFAULT_EXECUTION_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EXECUTIONS) {
    throw new Error('Automation execution limit must be an integer from 1 to 100');
  }
  return {
    projectId: validatedResourceId(context.positionals[0], 'Project id'),
    automationId: validatedResourceId(context.positionals[1], 'Automation id'),
    limit,
  };
}

async function projectAutomationsList(context: McpCommandContext): Promise<CommandResult> {
  const { projectId } = listInvocation(context);
  const path = `/api/projects/${encodeURIComponent(projectId)}/automations`;
  const result = await readApi(context.client, path);
  if (!result.ok) return failure(path, result);
  try {
    const automations = parseAutomationList(result.body, projectId);
    const triggerCounts = { schedule: 0, webhook: 0 };
    for (const automation of automations) triggerCounts[automation.triggerKind] += 1;
    return {
      ok: true,
      path,
      status: 200,
      count: automations.length,
      enabledCount: automations.filter(automation => automation.enabled).length,
      triggerCounts,
      automations,
    };
  } catch {
    return schemaDrift(path);
  }
}

async function projectAutomationGet(context: McpCommandContext): Promise<CommandResult> {
  const { projectId, automationId } = detailInvocation(context);
  const path = `/api/projects/${encodeURIComponent(projectId)}/automations`;
  const result = await readApi(context.client, path);
  if (!result.ok) return failure(path, result);
  try {
    const automations = parseAutomationList(result.body, projectId);
    const automation = automations.find(candidate => candidate.id === automationId);
    if (!automation) return { ok: false, path, status: 200, outcome: 'not_found' };
    return { ok: true, path, status: 200, automation };
  } catch {
    return schemaDrift(path);
  }
}

function parseStatusBody(body: JsonObject): CommandResult {
  requireExactKeys(body, ['ok', 'statuses', 'totals'], 'Automation-status response');
  if (body.ok !== true || !Array.isArray(body.statuses) || body.statuses.length > MAX_AUTOMATIONS) {
    throw new Error('Automation-status response is invalid');
  }
  if (!isRecord(body.totals)) throw new Error('Automation-status totals are invalid');
  requireExactKeys(body.totals, ['runs30d', 'succeeded30d'], 'Automation-status totals');
  const totalRuns30d = nonnegativeInteger(body.totals.runs30d, 'Total runs30d');
  const totalSucceeded30d = nonnegativeInteger(body.totals.succeeded30d, 'Total succeeded30d');
  if (totalSucceeded30d > totalRuns30d) throw new Error('Automation-status totals are inconsistent');
  const seen = new Set<string>();
  const statuses = body.statuses.map((value, index) => {
    if (!isRecord(value)) throw new Error('Automation status must be an object');
    requireExactKeys(value, [
      'automationId', 'lastStatus', 'lastError', 'lastExecutionAt', 'runs30d', 'succeeded30d',
    ], 'Automation status');
    const automationId = validatedResourceId(value.automationId, `Automation status ${index} id`);
    if (seen.has(automationId)) throw new Error('Automation-status response contains duplicate ids');
    seen.add(automationId);
    if (
      value.lastStatus !== undefined
      && value.lastStatus !== null
      && value.lastStatus !== 'accepted'
      && value.lastStatus !== 'thread_created'
      && value.lastStatus !== 'failed'
    ) throw new Error('Automation lastStatus is unsupported');
    const lastError = nullableBoundedString(value.lastError, 'Automation lastError', MAX_PRIVATE_ERROR_LENGTH);
    const runs30d = nonnegativeInteger(value.runs30d, 'Automation runs30d');
    const succeeded30d = nonnegativeInteger(value.succeeded30d, 'Automation succeeded30d');
    if (succeeded30d > runs30d) throw new Error('Automation status counts are inconsistent');
    return {
      automationId,
      lastStatus: value.lastStatus ?? null,
      hasLastError: Boolean(lastError),
      lastExecutionAt: validDatetimeOrNull(value.lastExecutionAt, 'Automation lastExecutionAt'),
      runs30d,
      succeeded30d,
    };
  });
  return {
    totals: { runs30d: totalRuns30d, succeeded30d: totalSucceeded30d },
    statuses,
  };
}

async function projectAutomationsStatus(context: McpCommandContext): Promise<CommandResult> {
  const { projectId } = statusInvocation(context);
  const path = `/api/projects/${encodeURIComponent(projectId)}/automations/status`;
  const result = await readApi(context.client, path);
  if (!result.ok) return failure(path, result);
  try {
    return { ok: true, path, status: 200, ...parseStatusBody(result.body) };
  } catch {
    return schemaDrift(path);
  }
}

function projectExecution(
  value: unknown,
  requestedProjectId: string,
  requestedAutomationId: string,
  index: number,
): CommandResult {
  if (!isRecord(value)) throw new Error('Automation execution must be an object');
  requireExactKeys(value, [
    'id',
    'automationId',
    'projectId',
    'triggerKind',
    'dedupeKey',
    'status',
    'threadId',
    'error',
    'payloadSummary',
    'createdAt',
    'updatedAt',
    'threadTitle',
    'runDurationMs',
  ], 'Automation execution');
  const id = validatedResourceId(value.id, `Automation execution ${index} id`);
  const automationId = validatedResourceId(value.automationId, `Automation execution ${index} automationId`);
  const projectId = validatedResourceId(value.projectId, `Automation execution ${index} projectId`);
  if (projectId !== requestedProjectId || automationId !== requestedAutomationId) {
    throw new Error('Automation execution target does not match the request');
  }
  if (value.triggerKind !== 'schedule' && value.triggerKind !== 'webhook') {
    throw new Error('Automation execution triggerKind is unsupported');
  }
  if (value.status !== 'accepted' && value.status !== 'thread_created' && value.status !== 'failed') {
    throw new Error('Automation execution status is unsupported');
  }
  boundedString(value.dedupeKey, 'Automation execution dedupeKey', MAX_OPAQUE_STRING_LENGTH);
  const threadId = value.threadId === undefined || value.threadId === null
    ? null
    : validatedResourceId(value.threadId, 'Automation execution threadId');
  const privateError = nullableBoundedString(value.error, 'Automation execution error', MAX_PRIVATE_ERROR_LENGTH);
  if (value.payloadSummary !== undefined && value.payloadSummary !== null && !isRecord(value.payloadSummary)) {
    throw new Error('Automation execution payloadSummary is invalid');
  }
  nullableBoundedString(value.threadTitle, 'Automation execution threadTitle', 160);
  let runDurationMs: number | null = null;
  if (value.runDurationMs !== undefined && value.runDurationMs !== null) {
    runDurationMs = nonnegativeInteger(value.runDurationMs, 'Automation execution runDurationMs');
  }
  return {
    id,
    automationId,
    projectId,
    triggerKind: value.triggerKind,
    status: value.status,
    threadId,
    hasError: Boolean(privateError),
    hasPayload: value.payloadSummary !== undefined && value.payloadSummary !== null,
    createdAt: validDatetimeOrNull(value.createdAt, 'Automation execution createdAt'),
    updatedAt: validDatetimeOrNull(value.updatedAt, 'Automation execution updatedAt'),
    runDurationMs,
  };
}

async function projectAutomationRunsList(context: McpCommandContext): Promise<CommandResult> {
  const { projectId, automationId, limit } = runsInvocation(context);
  const path = `/api/projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(automationId)}/executions?limit=${limit}`;
  const result = await readApi(context.client, path);
  if (!result.ok) return failure(path, result);
  try {
    requireExactKeys(result.body, ['ok', 'executions'], 'Automation-executions response');
    if (
      result.body.ok !== true
      || !Array.isArray(result.body.executions)
      || result.body.executions.length > limit
      || result.body.executions.length > MAX_EXECUTIONS
    ) throw new Error('Automation-executions response is invalid');
    const executions = result.body.executions.map((value, index) => (
      projectExecution(value, projectId, automationId, index)
    ));
    if (new Set(executions.map(execution => execution.id)).size !== executions.length) {
      throw new Error('Automation-executions response contains duplicate ids');
    }
    return { ok: true, path, status: 200, count: executions.length, executions };
  } catch {
    return schemaDrift(path);
  }
}

export const projectAutomationCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'project-automations-list',
    description: 'List bounded project automation metadata without prompts, credentials, or private errors',
    transport: 'mcp',
    validate: context => { listInvocation(context); },
    run: projectAutomationsList,
  },
  {
    name: 'project-automation-get',
    description: 'Read one automation from the bounded project list without exposing its prompt or credentials',
    transport: 'mcp',
    validate: context => { detailInvocation(context); },
    run: projectAutomationGet,
  },
  {
    name: 'project-automations-status',
    description: 'Read project automation health counts while suppressing private error text',
    transport: 'mcp',
    validate: context => { statusInvocation(context); },
    run: projectAutomationsStatus,
  },
  {
    name: 'project-automation-runs-list',
    description: 'List bounded automation execution receipts without payloads, prompts, titles, or error text',
    transport: 'mcp',
    validate: context => { runsInvocation(context); },
    run: projectAutomationRunsList,
  },
];
