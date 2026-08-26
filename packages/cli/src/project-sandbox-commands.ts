import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { CliCommandDefinition, CommandResult } from './command-registry';
import {
  loadResourcePolicy,
  type ResourcePolicy,
  validateResourcePolicyGrant,
} from './compatibility';

type JsonObject = Record<string, unknown>;

type ApiEnvelope = {
  ok: boolean;
  status: number;
  body: unknown;
};

type RebakePlanIdentity = {
  version: 1;
  kind: 'project_prebuild_rebake_plan';
  owner: {
    accountId: string;
    workspaceId: string;
  };
  origin: string;
  resource: {
    kind: 'project';
    id: string;
  };
  capability: 'project.prebuilds.rebake';
  risk: 'W2';
  policy: {
    issuedAt: string;
    expiresAt: string;
    grantDigest: string;
  };
  state: {
    prebuildDigest: string;
    sandboxDigest: string;
  };
  contract: {
    method: 'POST';
    path: '/api/projects/:projectId/prebuilds/rebake';
    requestBody: 'none';
  };
};

type RebakePlanFile = RebakePlanIdentity & {
  planDigest: string;
};

type RebakePolicyGrantIdentity = {
  version: 1;
  owner: {
    accountId: string;
    workspaceId: string;
  };
  origin: string;
  resource: {
    kind: 'project';
    id: string;
    riskCeiling: 'W1' | 'W2' | 'W3';
  };
  capability: 'project.prebuilds.rebake';
  grantRisk: 'W2';
  issuedAt: string;
  expiresAt: string;
};

const MCP_TIMEOUT_MS = 20_000;
const RESPONSE_MAX_BYTES = 512 * 1024;
const PLAN_MAX_BYTES = 32 * 1024;
const MAX_PREBUILD_ROWS = 100;
const DISPLAY_PREBUILD_ROWS = 5;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SAFE_STATUS_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SAFE_TRIGGER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const COMMIT_SHA_RE = /^[a-fA-F0-9]{7,64}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function schemaError(detail: string): never {
  throw new Error(`project_sandbox_response_schema_mismatch: ${detail}`);
}

function assertExactInputs(
  command: string,
  positionals: string[],
  flags: Map<string, string>,
  positionalCount: number,
  allowedFlags: readonly string[] = [],
): void {
  if (positionals.length !== positionalCount) {
    throw new Error(`${command} received an unexpected positional argument`);
  }
  const unknownFlags = [...flags.keys()].filter(flag => !allowedFlags.includes(flag));
  if (unknownFlags.length > 0) throw new Error(`${command} received unsupported flags`);
}

function projectId(positionals: string[]): string {
  const value = positionals[0]?.trim();
  if (!value || !PROJECT_ID_RE.test(value)) {
    throw new Error('A valid project id is required');
  }
  return value;
}

function exactFlag(flags: Map<string, string>, name: string, maximum: number): string {
  const value = flags.get(name)?.trim();
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`A valid --${name} value is required`);
  }
  return value;
}

function exactDigestFlag(flags: Map<string, string>, name: string): string {
  const value = exactFlag(flags, name, 64).toLowerCase();
  if (!DIGEST_RE.test(value)) throw new Error(`--${name} must be a lowercase SHA-256 digest`);
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requireExactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error(`${label} contains unsupported fields`);
  }
}

function exactIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function exactTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  const canonical = new Date(Date.parse(value)).toISOString();
  if (canonical !== value) throw new Error(`${label} must be a canonical ISO timestamp`);
  return canonical;
}

function exactOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Rebake plan origin is invalid');
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('Rebake plan origin is invalid');
  }
  if (origin.origin !== value || (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname))) {
    throw new Error('Rebake plan origin must be an exact HTTPS or loopback origin');
  }
  return origin.origin;
}

function canonicalRebakePolicyGrantIdentity(
  policy: ResourcePolicy,
  origin: string,
  projectIdValue: string,
): RebakePolicyGrantIdentity {
  const resource = policy.resources.find(candidate => (
    candidate.kind === 'project'
    && candidate.id === projectIdValue
    && candidate.capabilities.includes('project.prebuilds.rebake')
  ));
  if (!resource) throw new Error('Rebake policy is missing the exact project capability grant');
  return {
    version: policy.version,
    owner: {
      accountId: policy.owner.accountId,
      workspaceId: policy.owner.workspaceId,
    },
    origin,
    resource: {
      kind: 'project',
      id: projectIdValue,
      riskCeiling: resource.riskCeiling,
    },
    capability: 'project.prebuilds.rebake',
    grantRisk: 'W2',
    issuedAt: policy.issuedAt,
    expiresAt: policy.expiresAt,
  };
}

function rebakePolicyGrantDigest(
  policy: ResourcePolicy,
  origin: string,
  projectIdValue: string,
): string {
  return digest(canonicalRebakePolicyGrantIdentity(policy, origin, projectIdValue));
}

function canonicalRebakePlanIdentity(value: RebakePlanIdentity): RebakePlanIdentity {
  return {
    version: 1,
    kind: 'project_prebuild_rebake_plan',
    owner: {
      accountId: value.owner.accountId,
      workspaceId: value.owner.workspaceId,
    },
    origin: value.origin,
    resource: { kind: 'project', id: value.resource.id },
    capability: 'project.prebuilds.rebake',
    risk: 'W2',
    policy: {
      issuedAt: value.policy.issuedAt,
      expiresAt: value.policy.expiresAt,
      grantDigest: value.policy.grantDigest,
    },
    state: {
      prebuildDigest: value.state.prebuildDigest,
      sandboxDigest: value.state.sandboxDigest,
    },
    contract: {
      method: 'POST',
      path: '/api/projects/:projectId/prebuilds/rebake',
      requestBody: 'none',
    },
  };
}

function parseRebakePlan(value: unknown, now = Date.now()): RebakePlanFile {
  if (!isRecord(value)) throw new Error('Rebake plan must be a JSON object');
  requireExactKeys(value, [
    'version',
    'kind',
    'owner',
    'origin',
    'resource',
    'capability',
    'risk',
    'policy',
    'state',
    'contract',
    'planDigest',
  ], 'Rebake plan');
  if (value.version !== 1 || value.kind !== 'project_prebuild_rebake_plan') {
    throw new Error('Unsupported rebake plan version or kind');
  }
  if (!isRecord(value.owner)) throw new Error('Rebake plan owner is required');
  requireExactKeys(value.owner, ['accountId', 'workspaceId'], 'Rebake plan owner');
  if (!isRecord(value.resource)) throw new Error('Rebake plan resource is required');
  requireExactKeys(value.resource, ['kind', 'id'], 'Rebake plan resource');
  if (value.resource.kind !== 'project') throw new Error('Rebake plan resource kind is invalid');
  if (value.capability !== 'project.prebuilds.rebake' || value.risk !== 'W2') {
    throw new Error('Rebake plan capability or risk is invalid');
  }
  if (!isRecord(value.policy)) throw new Error('Rebake plan policy identity is required');
  requireExactKeys(value.policy, ['issuedAt', 'expiresAt', 'grantDigest'], 'Rebake plan policy');
  if (!isRecord(value.state)) throw new Error('Rebake plan state identity is required');
  requireExactKeys(value.state, ['prebuildDigest', 'sandboxDigest'], 'Rebake plan state');
  if (!isRecord(value.contract)) throw new Error('Rebake plan contract is required');
  requireExactKeys(value.contract, ['method', 'path', 'requestBody'], 'Rebake plan contract');
  if (
    value.contract.method !== 'POST'
    || value.contract.path !== '/api/projects/:projectId/prebuilds/rebake'
    || value.contract.requestBody !== 'none'
  ) {
    throw new Error('Rebake plan contract is invalid');
  }
  const issuedAt = exactTimestamp(value.policy.issuedAt, 'Rebake plan policy issuedAt');
  const expiresAt = exactTimestamp(value.policy.expiresAt, 'Rebake plan policy expiresAt');
  if (Date.parse(expiresAt) <= now) throw new Error('Rebake plan policy is expired');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new Error('Rebake plan policy expiry is invalid');
  if (Date.parse(expiresAt) - Date.parse(issuedAt) > 24 * 60 * 60_000) {
    throw new Error('Rebake plan policy lifetime exceeds 24 hours');
  }
  const prebuildDigest = String(value.state.prebuildDigest).toLowerCase();
  const sandboxDigest = String(value.state.sandboxDigest).toLowerCase();
  const grantDigest = String(value.policy.grantDigest).toLowerCase();
  const planDigest = String(value.planDigest).toLowerCase();
  if (
    !DIGEST_RE.test(prebuildDigest)
    || !DIGEST_RE.test(sandboxDigest)
    || !DIGEST_RE.test(grantDigest)
    || !DIGEST_RE.test(planDigest)
  ) {
    throw new Error('Rebake plan contains an invalid digest');
  }
  const identity = canonicalRebakePlanIdentity({
    version: 1,
    kind: 'project_prebuild_rebake_plan',
    owner: {
      accountId: exactIdentity(value.owner.accountId, 'Rebake plan account id'),
      workspaceId: exactIdentity(value.owner.workspaceId, 'Rebake plan workspace id'),
    },
    origin: exactOrigin(value.origin),
    resource: {
      kind: 'project',
      id: safePatternString(value.resource.id, 'Rebake plan project id', PROJECT_ID_RE),
    },
    capability: 'project.prebuilds.rebake',
    risk: 'W2',
    policy: { issuedAt, expiresAt, grantDigest },
    state: { prebuildDigest, sandboxDigest },
    contract: {
      method: 'POST',
      path: '/api/projects/:projectId/prebuilds/rebake',
      requestBody: 'none',
    },
  });
  if (digest(identity) !== planDigest) throw new Error('Rebake plan digest does not match its bounded identity');
  return { ...identity, planDigest };
}

function writeRebakePlan(path: string, plan: RebakePlanFile): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function loadRebakePlan(path: string, now = Date.now()): RebakePlanFile {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isRecord(error) && error.code === 'ELOOP') {
      throw new Error('Rebake plan must be a regular non-symlink file');
    }
    throw error;
  }
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error('Rebake plan must be a regular non-symlink file');
    const mode = metadata.mode & 0o777;
    if (mode !== 0o400 && mode !== 0o600) {
      throw new Error('Rebake plan permissions must be owner-only (0400 or 0600)');
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new Error('Rebake plan must be owned by the current user');
    }
    if (metadata.size > PLAN_MAX_BYTES) throw new Error('Rebake plan exceeds 32 KB');
    const raw = readFileSync(descriptor, 'utf8');
    if (new TextEncoder().encode(raw).byteLength > PLAN_MAX_BYTES) {
      throw new Error('Rebake plan exceeds 32 KB');
    }
    return parseRebakePlan(JSON.parse(raw) as unknown, now);
  } finally {
    closeSync(descriptor);
  }
}

function safeIntegerOrNull(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    schemaError(`${label} must be a positive safe integer or null`);
  }
  return value as number;
}

function safeTimestampOrNull(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    schemaError(`${label} must be a bounded timestamp or null`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function safePatternString(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) schemaError(`${label} is invalid`);
  return value;
}

function optionalPatternString(value: unknown, label: string, pattern: RegExp): string | null {
  if (value === undefined || value === null) return null;
  return safePatternString(value, label, pattern);
}

function parseSandboxSpec(value: unknown): JsonObject | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) schemaError('project.sandboxSpec must be an object or null');
  const runtimeProfile = value.runtimeProfile;
  if (runtimeProfile !== undefined && runtimeProfile !== null && runtimeProfile !== 'docker-compose') {
    schemaError('project.sandboxSpec.runtimeProfile is invalid');
  }
  return {
    defaultCpu: safeIntegerOrNull(value.defaultCpu, 'project.sandboxSpec.defaultCpu'),
    defaultMemoryGiB: safeIntegerOrNull(value.defaultMemoryGiB, 'project.sandboxSpec.defaultMemoryGiB'),
    maxCpu: safeIntegerOrNull(value.maxCpu, 'project.sandboxSpec.maxCpu'),
    maxMemoryGiB: safeIntegerOrNull(value.maxMemoryGiB, 'project.sandboxSpec.maxMemoryGiB'),
    maxDiskGiB: safeIntegerOrNull(value.maxDiskGiB, 'project.sandboxSpec.maxDiskGiB'),
    staffMaxCpu: safeIntegerOrNull(value.staffMaxCpu, 'project.sandboxSpec.staffMaxCpu'),
    staffMaxMemoryGiB: safeIntegerOrNull(value.staffMaxMemoryGiB, 'project.sandboxSpec.staffMaxMemoryGiB'),
    staffMaxDiskGiB: safeIntegerOrNull(value.staffMaxDiskGiB, 'project.sandboxSpec.staffMaxDiskGiB'),
    runtimeProfile: runtimeProfile ?? null,
  };
}

function projectSandboxProjection(body: unknown, expectedProjectId: string): CommandResult {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.project)) {
    schemaError('expected { ok: true, project: object }');
  }
  const project = body.project;
  const returnedProjectId = safePatternString(project.id, 'project.id', PROJECT_ID_RE);
  if (returnedProjectId !== expectedProjectId) schemaError('project.id did not match the requested project');
  if (project.prebuildsEnabled !== undefined && typeof project.prebuildsEnabled !== 'boolean') {
    schemaError('project.prebuildsEnabled must be boolean when present');
  }
  const sandboxFieldPresent = Object.hasOwn(project, 'sandboxSpec');
  const sandboxSpec = parseSandboxSpec(project.sandboxSpec);
  const overrideStatus = !sandboxFieldPresent
    ? 'not_returned'
    : sandboxSpec === null
      ? 'inherits_workspace_defaults'
      : 'project_override';
  const state = {
    projectId: returnedProjectId,
    prebuildsEnabled: typeof project.prebuildsEnabled === 'boolean' ? project.prebuildsEnabled : null,
    sandbox: {
      fieldPresent: sandboxFieldPresent,
      overrideStatus,
      spec: sandboxSpec,
    },
  };
  return {
    projectId: returnedProjectId,
    stateDigest: digest(state),
    prebuildsEnabled: state.prebuildsEnabled,
    sandbox: state.sandbox,
  };
}

function prebuildProjection(value: unknown, index: number): JsonObject {
  if (!isRecord(value)) schemaError(`prebuilds[${index}] must be an object`);
  const status = safePatternString(value.status, `prebuilds[${index}].status`, SAFE_STATUS_RE);
  return {
    id: safePatternString(value.id, `prebuilds[${index}].id`, SAFE_ID_RE),
    status,
    active: status === 'baking' || status === 'validating',
    repository: safePatternString(value.repoFullName, `prebuilds[${index}].repoFullName`, REPOSITORY_RE),
    commitSha: optionalPatternString(value.commitSha, `prebuilds[${index}].commitSha`, COMMIT_SHA_RE),
    trigger: safePatternString(value.trigger, `prebuilds[${index}].trigger`, SAFE_TRIGGER_RE),
    createdAt: safeTimestampOrNull(value.createdAt, `prebuilds[${index}].createdAt`),
    promotedAt: safeTimestampOrNull(value.promotedAt, `prebuilds[${index}].promotedAt`),
    failureDetailPresent: status === 'failed' && typeof value.error === 'string' && value.error.length > 0,
  };
}

function projectPrebuildsProjection(body: unknown, expectedProjectId: string): CommandResult {
  if (!isRecord(body) || body.ok !== true || !Array.isArray(body.prebuilds)) {
    schemaError('expected { ok: true, prebuilds: array }');
  }
  if (body.prebuilds.length > MAX_PREBUILD_ROWS) {
    schemaError(`prebuilds exceeds ${MAX_PREBUILD_ROWS} entries`);
  }
  const projected = body.prebuilds.map(prebuildProjection);
  const state = {
    projectId: expectedProjectId,
    prebuilds: projected.map(row => ({
      id: row.id,
      status: row.status,
      repository: row.repository,
      commitSha: row.commitSha,
      trigger: row.trigger,
      createdAt: row.createdAt,
      promotedAt: row.promotedAt,
    })),
  };
  return {
    projectId: expectedProjectId,
    stateDigest: digest(state),
    observedCount: projected.length,
    returnedCount: Math.min(projected.length, DISPLAY_PREBUILD_ROWS),
    moreEntriesOmitted: projected.length > DISPLAY_PREBUILD_ROWS,
    activeCount: projected.filter(row => row.active === true).length,
    prebuilds: projected.slice(0, DISPLAY_PREBUILD_ROWS),
  };
}

function parseJsonText(value: string, label: string): unknown {
  if (new TextEncoder().encode(value).byteLength > RESPONSE_MAX_BYTES) {
    schemaError(`${label} exceeds ${RESPONSE_MAX_BYTES} bytes`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    schemaError(`${label} is not valid JSON`);
  }
}

function parseToolEnvelope(result: unknown): ApiEnvelope {
  if (!isRecord(result)) schemaError('MCP result must be an object');
  if (Object.keys(result).some(key => !['content', 'isError'].includes(key))) {
    schemaError('MCP result contains unsupported top-level fields');
  }
  if (result.isError !== undefined && typeof result.isError !== 'boolean') {
    schemaError('MCP result isError must be boolean');
  }
  if (!Array.isArray(result.content) || result.content.length !== 1) {
    schemaError('MCP result must contain exactly one JSON text payload');
  }
  const item = result.content[0];
  if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') {
    schemaError('MCP result must contain exactly one JSON text payload');
  }
  if (Object.keys(item).some(key => !['type', 'text'].includes(key))) {
    schemaError('MCP text payload contains unsupported fields');
  }
  const parsed = parseJsonText(item.text, 'MCP payload');
  if (!isRecord(parsed) || Object.keys(parsed).some(key => !['ok', 'status', 'body'].includes(key))) {
    schemaError('API envelope contains unsupported fields');
  }
  if (typeof parsed.ok !== 'boolean' || !Number.isInteger(parsed.status) || !Object.hasOwn(parsed, 'body')) {
    schemaError('API envelope is missing required fields');
  }
  const status = parsed.status as number;
  if (status < 100 || status > 599) schemaError('API envelope status is invalid');
  let body = parsed.body;
  if (typeof body === 'string') body = parseJsonText(body, 'API body');
  return { ok: parsed.ok === true && result.isError !== true, status, body };
}

async function callReadRoute(client: Client, path: string): Promise<ApiEnvelope> {
  let raw: unknown;
  try {
    raw = await client.callTool(
      { name: 'hoplite_call_api', arguments: { method: 'GET', path } },
      undefined,
      { timeout: MCP_TIMEOUT_MS, maxTotalTimeout: MCP_TIMEOUT_MS },
    );
  } catch {
    throw new Error('project_sandbox_transport_error: MCP request failed before a validated response');
  }
  return parseToolEnvelope(raw);
}

function readFailure(status: number, surface: string): CommandResult {
  const outcome = {
    401: 'unsupported_credential',
    402: 'subscription_required',
    403: 'role_denied',
    404: 'project_or_route_not_found',
    405: 'route_not_available',
    429: 'rate_limited',
    501: 'deployment_unavailable',
  }[status] ?? 'request_failed';
  return {
    ok: false,
    status,
    outcome,
    surface,
    availability: 'unknown',
    remoteStateChanged: false,
  };
}

async function sandboxGet(client: Client, positionals: string[], flags: Map<string, string>): Promise<CommandResult> {
  assertExactInputs('project-sandbox-get', positionals, flags, 1);
  const targetProjectId = projectId(positionals);
  const response = await callReadRoute(client, `/api/projects/${encodeURIComponent(targetProjectId)}`);
  if (!response.ok || response.status !== 200) return readFailure(response.status, 'project-sandbox');
  return {
    ok: true,
    status: 200,
    availability: 'confirmed_for_current_credential',
    checkedAt: new Date().toISOString(),
    ...projectSandboxProjection(response.body, targetProjectId),
  };
}

async function prebuildsStatus(client: Client, positionals: string[], flags: Map<string, string>): Promise<CommandResult> {
  assertExactInputs('project-prebuilds-status', positionals, flags, 1);
  const targetProjectId = projectId(positionals);
  const response = await callReadRoute(client, `/api/projects/${encodeURIComponent(targetProjectId)}/prebuilds`);
  if (!response.ok || response.status !== 200) return readFailure(response.status, 'project-prebuilds');
  return {
    ok: true,
    status: 200,
    availability: 'confirmed_for_current_credential',
    authenticationCompatibility: 'confirmed_for_current_credential',
    checkedAt: new Date().toISOString(),
    ...projectPrebuildsProjection(response.body, targetProjectId),
  };
}

function rebakePlan(positionals: string[], flags: Map<string, string>): CommandResult {
  const allowedFlags = [
    'policy',
    'account-id',
    'workspace-id',
    'origin',
    'prebuild-digest',
    'sandbox-digest',
    'output',
  ];
  assertExactInputs('project-prebuilds-plan-rebake', positionals, flags, 1, allowedFlags);
  const targetProjectId = projectId(positionals);
  const policyPath = exactFlag(flags, 'policy', 4_096);
  const accountId = exactIdentity(exactFlag(flags, 'account-id', 256), 'Account id');
  const workspaceId = exactIdentity(exactFlag(flags, 'workspace-id', 256), 'Workspace id');
  const origin = exactOrigin(exactFlag(flags, 'origin', 2_048));
  const policy = loadResourcePolicy(policyPath);
  const grant = validateResourcePolicyGrant(policy, {
    accountId,
    workspaceId,
    origin,
    kind: 'project',
    resourceId: targetProjectId,
    capability: 'project.prebuilds.rebake',
  });
  const prebuildStateDigest = exactDigestFlag(flags, 'prebuild-digest');
  const sandboxStateDigest = exactDigestFlag(flags, 'sandbox-digest');
  const grantDigest = rebakePolicyGrantDigest(policy, origin, targetProjectId);
  const identity = canonicalRebakePlanIdentity({
    version: 1,
    kind: 'project_prebuild_rebake_plan',
    owner: { accountId, workspaceId },
    origin,
    resource: { kind: 'project', id: targetProjectId },
    capability: 'project.prebuilds.rebake',
    risk: 'W2',
    policy: { issuedAt: policy.issuedAt, expiresAt: policy.expiresAt, grantDigest },
    state: { prebuildDigest: prebuildStateDigest, sandboxDigest: sandboxStateDigest },
    contract: {
      method: 'POST',
      path: '/api/projects/:projectId/prebuilds/rebake',
      requestBody: 'none',
    },
  });
  const planDigest = digest(identity);
  const plan: RebakePlanFile = { ...identity, planDigest };
  writeRebakePlan(exactFlag(flags, 'output', 4_096), plan);
  return {
    ok: true,
    kind: 'local_plan_file_receipt',
    capability: 'project.prebuilds.rebake',
    risk: 'W2',
    policy: {
      authorizedForLocalPlanning: grant.authorized === true,
      expiresAt: policy.expiresAt,
    },
    projectId: targetProjectId,
    state: {
      prebuildDigest: prebuildStateDigest,
      sandboxDigest: sandboxStateDigest,
    },
    planDigest,
    planFileWritten: true,
    planFileMode: '0600',
    remoteApply: 'blocked',
    observedContract: {
      method: 'POST',
      path: '/api/projects/:projectId/prebuilds/rebake',
      requestBody: 'none',
      responseProjection: { dispatched: 'integer', eligible: 'optional integer' },
    },
    preconditions: [
      'Re-read project-prebuilds-status and require an exact prebuildStateDigest match.',
      'Re-read project-sandbox-get, require an exact sandboxStateDigest match, and confirm prebuilds are enabled.',
      'Confirm a project repository remains linked through project-repository-get or the Hoplite settings UI.',
      'Confirm no bake is currently in baking or validating state.',
    ],
    blockedReasons: [
      'OAuth compatibility and owner authorization for the undocumented POST have not been verified.',
      'The client contract supplies no idempotency key, so an ambiguous response cannot be retried safely.',
      'Compute consumption, dispatch acceptance, and post-write reconciliation have not been proven in an isolated project.',
    ],
  };
}

function blockedApplyReceipt(positionals: string[], flags: Map<string, string>): CommandResult {
  const allowedFlags = [
    'plan',
    'policy',
    'account-id',
    'workspace-id',
    'origin',
    'prebuild-digest',
    'sandbox-digest',
  ];
  assertExactInputs('project-prebuilds-apply', positionals, flags, 1, allowedFlags);
  const targetProjectId = projectId(positionals);
  const plan = loadRebakePlan(exactFlag(flags, 'plan', 4_096));
  if (plan.resource.id !== targetProjectId) throw new Error('Rebake plan project does not match the requested project');
  const accountId = exactIdentity(exactFlag(flags, 'account-id', 256), 'Account id');
  const workspaceId = exactIdentity(exactFlag(flags, 'workspace-id', 256), 'Workspace id');
  const origin = exactOrigin(exactFlag(flags, 'origin', 2_048));
  if (
    plan.owner.accountId !== accountId
    || plan.owner.workspaceId !== workspaceId
    || plan.origin !== origin
  ) {
    throw new Error('Rebake plan owner, workspace, or origin does not match the requested identity');
  }
  const prebuildDigest = exactDigestFlag(flags, 'prebuild-digest');
  const sandboxDigest = exactDigestFlag(flags, 'sandbox-digest');
  if (plan.state.prebuildDigest !== prebuildDigest || plan.state.sandboxDigest !== sandboxDigest) {
    throw new Error('Rebake plan state digests do not match the current supplied state');
  }
  const policy = loadResourcePolicy(exactFlag(flags, 'policy', 4_096));
  const grant = validateResourcePolicyGrant(policy, {
    accountId,
    workspaceId,
    origin,
    kind: 'project',
    resourceId: targetProjectId,
    capability: 'project.prebuilds.rebake',
  });
  const grantDigest = rebakePolicyGrantDigest(policy, origin, targetProjectId);
  if (
    policy.issuedAt !== plan.policy.issuedAt
    || policy.expiresAt !== plan.policy.expiresAt
    || grantDigest !== plan.policy.grantDigest
  ) {
    throw new Error('Rebake plan policy or exact grant identity no longer matches the current policy file');
  }
  const receipt = {
    kind: 'blocked_apply_receipt',
    projectId: targetProjectId,
    planDigest: plan.planDigest,
    outcome: 'blocked',
  };
  return {
    ok: false,
    ...receipt,
    receiptDigest: digest(receipt),
    planFileVerified: true,
    policyGrantVerified: grant.authorized === true,
    policyExpiresAt: policy.expiresAt,
    suppliedStateDigestsMatched: true,
    remoteRequestSent: false,
    remoteStateChanged: false,
    retryAllowed: false,
    message: 'Prebuild rebake apply is intentionally unavailable until authentication, idempotency, compute-impact, and readback contracts are proven.',
    recovery: 'Use the reviewed local plan and complete the rebake in Hoplite settings when a human has approved the compute action.',
  };
}

export const projectSandboxCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'project-sandbox-get',
    description: 'Read bounded project sandbox overrides and prebuild enablement through the public project contract',
    transport: 'mcp',
    run: ({ client, positionals, flags }) => sandboxGet(client, positionals, flags),
  },
  {
    name: 'project-prebuilds-status',
    description: 'Read at most five projected warm-snapshot records from the evidenced project prebuild route',
    transport: 'mcp',
    run: ({ client, positionals, flags }) => prebuildsStatus(client, positionals, flags),
  },
  {
    name: 'project-prebuilds-plan-rebake',
    description: 'Write an owner-only, policy-bound local W2 rebake plan file without contacting Hoplite',
    transport: 'local',
    run: ({ positionals, flags }) => rebakePlan(positionals, flags),
  },
  {
    name: 'project-prebuilds-apply',
    description: 'Validate an owner-only rebake plan and emit a blocked receipt; never sends the POST',
    transport: 'local',
    run: ({ positionals, flags }) => blockedApplyReceipt(positionals, flags),
  },
];
