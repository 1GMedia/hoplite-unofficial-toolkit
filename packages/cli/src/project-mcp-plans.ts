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

import type { CliCommandDefinition, CommandResult } from './command-registry';
import {
  loadResourcePolicy,
  type ResourcePolicy,
  validateResourcePolicyGrant,
} from './compatibility';
import { validateMcpEndpointUrl } from './mcp-endpoint-policy';

type JsonObject = Record<string, unknown>;
type PlanAction = 'add' | 'update' | 'remove';
type PlanCapability = 'mcp.servers.create' | 'mcp.servers.update' | 'mcp.servers.delete';
type PlanRisk = 'W2' | 'W3';

type ProjectMcpConfig = {
  version: 1;
  name: string;
  enabled: boolean;
  config: {
    transport: 'http' | 'sse';
    url: string;
    auth:
      | { type: 'none' }
      | { type: 'bearer'; secretRef: { source: 'environment'; name: string } };
  };
  toolScope:
    | { mode: 'all' }
    | { mode: 'allow' | 'deny'; tools: string[] };
};

type ProjectMcpBeforeStateIdentity = {
  version: 1;
  kind: 'hoplite_project_mcp_before_state';
  owner: { accountId: string; workspaceId: string };
  origin: string;
  resource: { kind: 'project'; id: string };
  server: { id: string };
  observedAt: string;
  configDigest: string;
};

type ProjectMcpBeforeState = ProjectMcpBeforeStateIdentity & { stateDigest: string };

type ProjectMcpPlanIdentity = {
  version: 1;
  kind: 'hoplite_project_mcp_plan';
  action: PlanAction;
  createdAt: string;
  expiresAt: string;
  owner: { accountId: string; workspaceId: string };
  origin: string;
  resource: { kind: 'project'; id: string };
  server: { id: string | null; nameDigest: string | null };
  capability: PlanCapability;
  risk: PlanRisk;
  clientOperationId: string;
  policy: { issuedAt: string; expiresAt: string; grantDigest: string };
  desiredConfig: { value: ProjectMcpConfig | null; digest: string };
  beforeState: {
    digest: string;
    configDigest: string;
    observedAt: string;
  } | null;
  contract: {
    method: 'POST' | 'PATCH' | 'DELETE';
    path: '/api/mcp/servers' | '/api/mcp/servers/:serverId';
    remoteApply: 'blocked';
    networkRequests: 'none';
  };
};

type ProjectMcpPlan = ProjectMcpPlanIdentity & { planDigest: string };

const FILE_MAX_BYTES = 64 * 1024;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SERVER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const OWNER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const CLIENT_OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SERVER_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 _.-]{0,78}[A-Za-z0-9])?$/;
const ENVIRONMENT_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const SECRETISH_KEY_RE = /(?:authorization|headers?|cookie|credential|password|private[_-]?key|secret|token|api[_-]?key|client[_-]?secret|command|args|cwd|env)$/i;
const SECRETISH_PATH_RE = /(?:access|refresh|bearer|authorization|credential|password|secret|token|api[-_]?key|client[-_]?secret)/i;
const HIGH_ENTROPY_PATH_RE = /(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{40,}|[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})/;

const ACTION_CONTRACT: Readonly<Record<PlanAction, {
  capability: PlanCapability;
  risk: PlanRisk;
  method: 'POST' | 'PATCH' | 'DELETE';
  path: '/api/mcp/servers' | '/api/mcp/servers/:serverId';
}>> = {
  add: { capability: 'mcp.servers.create', risk: 'W2', method: 'POST', path: '/api/mcp/servers' },
  update: { capability: 'mcp.servers.update', risk: 'W2', method: 'PATCH', path: '/api/mcp/servers/:serverId' },
  remove: { capability: 'mcp.servers.delete', risk: 'W3', method: 'DELETE', path: '/api/mcp/servers/:serverId' },
};

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requireExactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported fields`);
}

function assertNoSecretishUnknownKeys(value: unknown, depth = 0): void {
  if (depth > 8) throw new Error('MCP configuration nesting exceeds the supported depth');
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretishUnknownKeys(item, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRETISH_KEY_RE.test(key) && !['secretRef'].includes(key)) {
      throw new Error('MCP configuration contains an unsupported secret, header, environment, or stdio field');
    }
    assertNoSecretishUnknownKeys(nested, depth + 1);
  }
}

function strictString(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function exactTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  const canonical = new Date(Date.parse(value)).toISOString();
  if (canonical !== value) throw new Error(`${label} must be a canonical ISO timestamp`);
  return canonical;
}

function exactOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('A valid exact --origin is required');
  }
  if (parsed.origin !== value || (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new Error('A valid exact --origin is required');
  }
  return parsed.origin;
}

function assertSafeEndpointPath(canonicalUrl: string): void {
  const pathname = new URL(canonicalUrl).pathname;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new Error('MCP endpoint path contains invalid encoding');
  }
  if (SECRETISH_PATH_RE.test(decoded) || HIGH_ENTROPY_PATH_RE.test(decoded)) {
    throw new Error('MCP endpoint path appears to contain an embedded credential or secret value');
  }
  if (decoded.split('/').some(segment => segment.length > 128)) {
    throw new Error('MCP endpoint path contains an overlong segment');
  }
}

function parseAuth(value: unknown): ProjectMcpConfig['config']['auth'] {
  if (!isRecord(value)) throw new Error('MCP configuration auth must be an object');
  if (value.type === 'none') {
    requireExactKeys(value, ['type'], 'MCP configuration auth');
    return { type: 'none' };
  }
  if (value.type !== 'bearer') {
    throw new Error('MCP configuration auth supports only none or bearer secret references');
  }
  requireExactKeys(value, ['type', 'secretRef'], 'MCP configuration auth');
  if (!isRecord(value.secretRef)) throw new Error('MCP bearer auth requires a secretRef object');
  requireExactKeys(value.secretRef, ['source', 'name'], 'MCP configuration secretRef');
  if (value.secretRef.source !== 'environment') {
    throw new Error('MCP secretRef source must be environment');
  }
  return {
    type: 'bearer',
    secretRef: {
      source: 'environment',
      name: strictString(value.secretRef.name, 'MCP secretRef environment name', ENVIRONMENT_NAME_RE),
    },
  };
}

function parseToolScope(value: unknown): ProjectMcpConfig['toolScope'] {
  if (!isRecord(value)) throw new Error('MCP configuration toolScope must be an object');
  if (value.mode === 'all') {
    requireExactKeys(value, ['mode'], 'MCP configuration toolScope');
    return { mode: 'all' };
  }
  if (value.mode !== 'allow' && value.mode !== 'deny') {
    throw new Error('MCP configuration toolScope mode must be all, allow, or deny');
  }
  requireExactKeys(value, ['mode', 'tools'], 'MCP configuration toolScope');
  if (!Array.isArray(value.tools) || value.tools.length < 1 || value.tools.length > 100) {
    throw new Error('MCP configuration toolScope must contain between 1 and 100 tools');
  }
  const tools = value.tools.map(tool => strictString(tool, 'MCP tool scope entry', TOOL_NAME_RE));
  if (new Set(tools).size !== tools.length) throw new Error('MCP tool scope entries must be unique');
  return { mode: value.mode, tools: [...tools].sort() };
}

export function parseProjectMcpConfig(value: unknown): ProjectMcpConfig {
  if (!isRecord(value)) throw new Error('MCP configuration must be a JSON object');
  assertNoSecretishUnknownKeys(value);
  requireExactKeys(value, ['version', 'name', 'enabled', 'config', 'toolScope'], 'MCP configuration');
  if (value.version !== 1) throw new Error('Unsupported MCP configuration version');
  const name = strictString(value.name, 'MCP server name', SERVER_NAME_RE);
  if (typeof value.enabled !== 'boolean') throw new Error('MCP configuration enabled must be boolean');
  if (!isRecord(value.config)) throw new Error('MCP configuration config must be an object');
  requireExactKeys(value.config, ['transport', 'url', 'auth'], 'MCP configuration config');
  if (value.config.transport !== 'http' && value.config.transport !== 'sse') {
    throw new Error('MCP configuration supports only http and sse transports; stdio is rejected');
  }
  if (typeof value.config.url !== 'string') throw new Error('MCP configuration URL is required');
  const endpoint = validateMcpEndpointUrl(value.config.url);
  assertSafeEndpointPath(endpoint.canonicalUrl);
  return {
    version: 1,
    name,
    enabled: value.enabled,
    config: {
      transport: value.config.transport,
      url: endpoint.canonicalUrl,
      auth: parseAuth(value.config.auth),
    },
    toolScope: parseToolScope(value.toolScope),
  };
}

function readOwnerOnlyJson(path: string, label: string): unknown {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isRecord(error) && error.code === 'ELOOP') throw new Error(`${label} must be a regular non-symlink file`);
    throw new Error(`${label} could not be opened safely`);
  }
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
    const mode = metadata.mode & 0o777;
    if (mode !== 0o400 && mode !== 0o600) throw new Error(`${label} permissions must be owner-only (0400 or 0600)`);
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new Error(`${label} must be owned by the current user`);
    }
    if (metadata.size > FILE_MAX_BYTES) throw new Error(`${label} exceeds 64 KB`);
    const text = readFileSync(descriptor, 'utf8');
    if (new TextEncoder().encode(text).byteLength > FILE_MAX_BYTES) throw new Error(`${label} exceeds 64 KB`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${label} must contain valid JSON`);
    }
  } finally {
    closeSync(descriptor);
  }
}

export function loadProjectMcpConfig(path: string): ProjectMcpConfig {
  return parseProjectMcpConfig(readOwnerOnlyJson(path, 'MCP configuration file'));
}

function beforeStateIdentity(value: ProjectMcpBeforeStateIdentity): ProjectMcpBeforeStateIdentity {
  return {
    version: 1,
    kind: 'hoplite_project_mcp_before_state',
    owner: { accountId: value.owner.accountId, workspaceId: value.owner.workspaceId },
    origin: value.origin,
    resource: { kind: 'project', id: value.resource.id },
    server: { id: value.server.id },
    observedAt: value.observedAt,
    configDigest: value.configDigest,
  };
}

export function parseProjectMcpBeforeState(value: unknown, now = Date.now()): ProjectMcpBeforeState {
  if (!isRecord(value)) throw new Error('MCP before-state must be a JSON object');
  requireExactKeys(value, ['version', 'kind', 'owner', 'origin', 'resource', 'server', 'observedAt', 'configDigest', 'stateDigest'], 'MCP before-state');
  if (value.version !== 1 || value.kind !== 'hoplite_project_mcp_before_state') {
    throw new Error('Unsupported MCP before-state version or kind');
  }
  if (!isRecord(value.owner) || !isRecord(value.resource) || !isRecord(value.server)) {
    throw new Error('MCP before-state identity is incomplete');
  }
  requireExactKeys(value.owner, ['accountId', 'workspaceId'], 'MCP before-state owner');
  requireExactKeys(value.resource, ['kind', 'id'], 'MCP before-state resource');
  requireExactKeys(value.server, ['id'], 'MCP before-state server');
  if (value.resource.kind !== 'project') throw new Error('MCP before-state resource must be a project');
  const observedAt = exactTimestamp(value.observedAt, 'MCP before-state observedAt');
  const observedAtMs = Date.parse(observedAt);
  if (observedAtMs > now + 5 * 60_000 || observedAtMs < now - 24 * 60 * 60_000) {
    throw new Error('MCP before-state observation must be current within 24 hours');
  }
  const configDigest = strictString(value.configDigest, 'MCP before-state configDigest', DIGEST_RE);
  const identity = beforeStateIdentity({
    version: 1,
    kind: 'hoplite_project_mcp_before_state',
    owner: {
      accountId: strictString(value.owner.accountId, 'MCP before-state account id', OWNER_ID_RE),
      workspaceId: strictString(value.owner.workspaceId, 'MCP before-state workspace id', OWNER_ID_RE),
    },
    origin: exactOrigin(strictString(value.origin, 'MCP before-state origin', /^.{1,2048}$/)),
    resource: {
      kind: 'project',
      id: strictString(value.resource.id, 'MCP before-state project id', PROJECT_ID_RE),
    },
    server: { id: strictString(value.server.id, 'MCP before-state server id', SERVER_ID_RE) },
    observedAt,
    configDigest,
  });
  const stateDigest = strictString(value.stateDigest, 'MCP before-state stateDigest', DIGEST_RE);
  if (digest(identity) !== stateDigest) throw new Error('MCP before-state digest does not match its bounded identity');
  return { ...identity, stateDigest };
}

function loadBeforeState(path: string, now = Date.now()): ProjectMcpBeforeState {
  return parseProjectMcpBeforeState(readOwnerOnlyJson(path, 'MCP before-state file'), now);
}

function writePlan(path: string, plan: ProjectMcpPlan): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  } catch (error) {
    if (descriptor === undefined) throw new Error('MCP plan output could not be created safely without overwriting an existing file');
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertInvocation(
  command: string,
  positionals: string[],
  flags: Map<string, string>,
  positionalCount: number,
  allowedFlags: readonly string[],
): void {
  if (positionals.length !== positionalCount) throw new Error(`${command} received an unexpected positional argument`);
  if ([...flags.keys()].some(flag => !allowedFlags.includes(flag))) {
    throw new Error(`${command} received unsupported flags`);
  }
}

function requiredFlag(flags: Map<string, string>, name: string, maximum = 4_096): string {
  const value = flags.get(name);
  if (!value || value === 'true' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function policyGrantDigest(
  policy: ResourcePolicy,
  origin: string,
  projectId: string,
  capability: PlanCapability,
  risk: PlanRisk,
): string {
  const resource = policy.resources.find(candidate => (
    candidate.kind === 'project'
    && candidate.id === projectId
    && candidate.capabilities.includes(capability)
  ));
  if (!resource) throw new Error('MCP resource policy is missing the exact project capability grant');
  return digest({
    version: policy.version,
    owner: policy.owner,
    origin,
    resource: { kind: 'project', id: projectId, riskCeiling: resource.riskCeiling },
    capability,
    risk,
    issuedAt: policy.issuedAt,
    expiresAt: policy.expiresAt,
  });
}

function configSummary(config: ProjectMcpConfig): CommandResult {
  const secretReferenceCount = config.config.auth.type === 'bearer' ? 1 : 0;
  const toolScopeCount = config.toolScope.mode === 'all' ? 0 : config.toolScope.tools.length;
  return {
    transport: config.config.transport,
    auth: config.config.auth.type === 'none' ? 'none' : 'bearer_secret_reference',
    configuredFieldCount: 7 + secretReferenceCount * 2 + toolScopeCount,
    secretReferenceCount,
    toolScopeCount,
    configDigest: digest(config),
  };
}

function configCheck(positionals: string[], flags: Map<string, string>): CommandResult {
  assertInvocation('project-mcp-config-check', positionals, flags, 0, ['file']);
  const config = loadProjectMcpConfig(requiredFlag(flags, 'file'));
  return {
    operation: 'project_mcp_config_check',
    valid: true,
    ...configSummary(config),
    dnsLookups: 0,
    targetRequests: 0,
    hopliteRequests: 0,
    remoteStateChanged: false,
  };
}

function planIdentity(value: ProjectMcpPlanIdentity): ProjectMcpPlanIdentity {
  return {
    version: 1,
    kind: 'hoplite_project_mcp_plan',
    action: value.action,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    owner: { accountId: value.owner.accountId, workspaceId: value.owner.workspaceId },
    origin: value.origin,
    resource: { kind: 'project', id: value.resource.id },
    server: { id: value.server.id, nameDigest: value.server.nameDigest },
    capability: value.capability,
    risk: value.risk,
    clientOperationId: value.clientOperationId,
    policy: { ...value.policy },
    desiredConfig: { value: value.desiredConfig.value, digest: value.desiredConfig.digest },
    beforeState: value.beforeState ? { ...value.beforeState } : null,
    contract: { ...value.contract },
  };
}

function planCommand(action: PlanAction, positionals: string[], flags: Map<string, string>): CommandResult {
  const needsConfig = action !== 'remove';
  const needsBeforeState = action !== 'add';
  const allowedFlags = [
    ...(needsConfig ? ['config-file'] : []),
    ...(needsBeforeState ? ['before-state'] : []),
    'policy',
    'account-id',
    'workspace-id',
    'origin',
    'client-operation-id',
    'out',
  ];
  const command = `project-mcp-plan-${action}`;
  assertInvocation(command, positionals, flags, action === 'add' ? 1 : 2, allowedFlags);
  const projectId = strictString(positionals[0], 'Hoplite project id', PROJECT_ID_RE);
  const serverId = action === 'add' ? null : strictString(positionals[1], 'Hoplite MCP server id', SERVER_ID_RE);
  const accountId = strictString(requiredFlag(flags, 'account-id', 256), 'Account id', OWNER_ID_RE);
  const workspaceId = strictString(requiredFlag(flags, 'workspace-id', 256), 'Workspace id', OWNER_ID_RE);
  const origin = exactOrigin(requiredFlag(flags, 'origin', 2_048));
  const clientOperationId = strictString(
    requiredFlag(flags, 'client-operation-id', 128),
    'client-operation-id',
    CLIENT_OPERATION_ID_RE,
  );
  const outputPath = requiredFlag(flags, 'out');
  const contract = ACTION_CONTRACT[action];
  const policy = loadResourcePolicy(requiredFlag(flags, 'policy'));
  const grant = validateResourcePolicyGrant(policy, {
    accountId,
    workspaceId,
    origin,
    kind: 'project',
    resourceId: projectId,
    capability: contract.capability,
  });
  const config = needsConfig ? loadProjectMcpConfig(requiredFlag(flags, 'config-file')) : null;
  const beforeState = needsBeforeState ? loadBeforeState(requiredFlag(flags, 'before-state')) : null;
  if (beforeState && (
    beforeState.owner.accountId !== accountId
    || beforeState.owner.workspaceId !== workspaceId
    || beforeState.origin !== origin
    || beforeState.resource.id !== projectId
    || beforeState.server.id !== serverId
  )) {
    throw new Error('MCP before-state does not match the exact owner, origin, project, and server target');
  }
  const configDigest = config ? digest(config) : beforeState!.configDigest;
  const createdAt = new Date().toISOString();
  const identity = planIdentity({
    version: 1,
    kind: 'hoplite_project_mcp_plan',
    action,
    createdAt,
    expiresAt: policy.expiresAt,
    owner: { accountId, workspaceId },
    origin,
    resource: { kind: 'project', id: projectId },
    server: {
      id: serverId,
      nameDigest: config ? digest(config.name) : null,
    },
    capability: contract.capability,
    risk: contract.risk,
    clientOperationId,
    policy: {
      issuedAt: policy.issuedAt,
      expiresAt: policy.expiresAt,
      grantDigest: policyGrantDigest(policy, origin, projectId, contract.capability, contract.risk),
    },
    desiredConfig: { value: config, digest: configDigest },
    beforeState: beforeState ? {
      digest: beforeState.stateDigest,
      configDigest: beforeState.configDigest,
      observedAt: beforeState.observedAt,
    } : null,
    contract: {
      method: contract.method,
      path: contract.path,
      remoteApply: 'blocked',
      networkRequests: 'none',
    },
  });
  const planDigest = digest(identity);
  writePlan(outputPath, { ...identity, planDigest });
  const summary = config
    ? configSummary(config)
    : {
        transport: 'not_applicable',
        auth: 'not_applicable',
        configuredFieldCount: 0,
        secretReferenceCount: 0,
        toolScopeCount: 0,
        configDigest,
      };
  const receiptIdentity = {
    kind: 'local_project_mcp_plan_receipt',
    action,
    capability: contract.capability,
    risk: contract.risk,
    planDigest,
    configDigest,
    beforeStateDigest: beforeState?.stateDigest ?? null,
    clientOperationDigest: digest(clientOperationId),
    expiresAt: policy.expiresAt,
  };
  return {
    operation: 'project_mcp_plan',
    action,
    capability: contract.capability,
    risk: contract.risk,
    policyAuthorized: grant.authorized === true,
    expiresAt: policy.expiresAt,
    ...summary,
    beforeStateDigest: beforeState?.stateDigest ?? null,
    clientOperationDigest: digest(clientOperationId),
    planDigest,
    receipt: digest(receiptIdentity),
    planFileWritten: true,
    planFileMode: '0600',
    dnsLookups: 0,
    targetRequests: 0,
    hopliteRequests: 0,
    remoteApply: 'blocked',
    remoteStateChanged: false,
    retryAllowed: false,
  };
}

export const projectMcpPlanCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'project-mcp-config-check',
    description: 'Validate one owner-only HTTP/SSE MCP config locally without printing endpoint or secret-reference details',
    transport: 'local',
    run: ({ positionals, flags }) => configCheck(positionals, flags),
  },
  {
    name: 'project-mcp-plan-add',
    description: 'Write an owner-only, expiring, policy-bound local MCP add plan; never contacts Hoplite or the endpoint',
    transport: 'local',
    run: ({ positionals, flags }) => planCommand('add', positionals, flags),
  },
  {
    name: 'project-mcp-plan-update',
    description: 'Write an owner-only local MCP update plan bound to a current before-state digest; never applies it',
    transport: 'local',
    run: ({ positionals, flags }) => planCommand('update', positionals, flags),
  },
  {
    name: 'project-mcp-plan-remove',
    description: 'Write an owner-only W3 MCP removal plan bound to a current before-state digest; never applies it',
    transport: 'local',
    run: ({ positionals, flags }) => planCommand('remove', positionals, flags),
  },
];
