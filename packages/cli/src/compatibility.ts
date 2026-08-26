import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from 'node:fs';

export type CapabilitySourceTier =
  | 'official-openapi'
  | 'official-docs'
  | 'authenticated-client'
  | 'live-mcp';

export type CapabilityAuthStatus =
  | 'oauth-confirmed'
  | 'api-key-confirmed'
  | 'browser-session-only'
  | 'unverified';

export type CapabilityRisk = 'R0' | 'W1' | 'W2' | 'W3';
export type CapabilityStatus = 'implemented' | 'discovered' | 'blocked';

export type CompatibilityIdentity = {
  registryVersion: 1;
  openApi: {
    url: string;
    sha256: string;
  };
  client: {
    release: string;
    apiClientSha256: string;
  };
};

export type CompatibilityCapability = {
  id: string;
  area: string;
  action: string;
  sourceTier: CapabilitySourceTier;
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'LOCAL';
  path: string;
  authStatus: CapabilityAuthStatus;
  risk: CapabilityRisk;
  status: CapabilityStatus;
  lastVerified: string;
  payloadEvidence: string;
  callerEvidence: string;
  sideEffects: string;
  notes?: string;
};

export type CompatibilitySnapshot = {
  identity: CompatibilityIdentity;
  generatedAt: string;
  filter?: {
    area: string;
  };
  capabilities: CompatibilityCapability[];
};

export type ResourcePolicy = {
  version: 1;
  owner: {
    accountId: string;
    workspaceId: string;
  };
  origins: string[];
  resources: Array<{
    kind: 'project' | 'workspace';
    id: string;
    capabilities: string[];
    riskCeiling: Exclude<CapabilityRisk, 'R0'>;
  }>;
  issuedAt: string;
  expiresAt: string;
};

export type ResourcePolicyGrantRequest = {
  accountId: string;
  workspaceId: string;
  origin: string;
  kind: 'project' | 'workspace';
  resourceId: string;
  capability: string;
};

const VERIFIED_AT = '2026-08-25';
const POLICY_MAX_BYTES = 32 * 1024;
const POLICY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const CAPABILITY_ID_RE = /^[a-z][a-z0-9.-]{2,127}$/;

export const COMPATIBILITY_IDENTITY: CompatibilityIdentity = {
  registryVersion: 1,
  openApi: {
    url: 'https://hoplite.sh/docs/openapi.json',
    sha256: '7ea9c7b8d8e74deac179044134d17d1df38556faf46631e527f824552129da45',
  },
  client: {
    release: '97462d3aff299f96fc632f69b0c941a036c83eb0',
    apiClientSha256: 'aff5ae4af836cfc655cf5d6b1b9a7f31afe58ae2b088363638b9dfa9444c0743',
  },
};

type CapabilityInput = Omit<
  CompatibilityCapability,
  'lastVerified' | 'payloadEvidence' | 'callerEvidence' | 'sideEffects'
> & Partial<Pick<CompatibilityCapability, 'payloadEvidence' | 'callerEvidence' | 'sideEffects'>>;

export function defaultCallerEvidence(sourceTier: CapabilitySourceTier): string {
  return {
    'official-openapi': 'Official Hoplite OpenAPI snapshot recorded by this registry identity.',
    'official-docs': 'Official Hoplite documentation recorded during the stated verification date.',
    'authenticated-client': `Authenticated Hoplite web client release ${COMPATIBILITY_IDENTITY.client.release}.`,
    'live-mcp': 'Live Hoplite MCP tool schema observed during the stated verification date.',
  }[sourceTier];
}

const capability = (value: CapabilityInput): CompatibilityCapability => ({
  ...value,
  payloadEvidence: value.payloadEvidence ?? (
    value.method === 'GET' || value.method === 'HEAD'
      ? 'Path parameters and bounded query only; response projection must be command-specific.'
      : 'Exact write payload is not registered; implementation remains unauthorized.'
  ),
  callerEvidence: value.callerEvidence ?? defaultCallerEvidence(value.sourceTier),
  sideEffects: value.sideEffects ?? (
    value.risk === 'R0'
      ? 'Read-only observation.'
      : 'Remote state change; exact blast radius and readback remain unverified.'
  ),
  lastVerified: VERIFIED_AT,
});

// Registry entries are evidence records, not permission grants. A discovered
// browser contract remains unavailable for writes until a dedicated command
// supplies a strict schema, policy check, confirmation, and readback.
export const COMPATIBILITY_REGISTRY: readonly CompatibilityCapability[] = [
  capability({ id: 'project.list', area: 'projects', action: 'list', sourceTier: 'official-openapi', method: 'GET', path: '/api/projects', authStatus: 'oauth-confirmed', risk: 'R0', status: 'implemented' }),
  capability({ id: 'project.get', area: 'projects', action: 'get', sourceTier: 'official-openapi', method: 'GET', path: '/api/projects/:projectId', authStatus: 'oauth-confirmed', risk: 'R0', status: 'implemented' }),
  capability({ id: 'models.list', area: 'project-agents', action: 'list-model-providers', sourceTier: 'authenticated-client', method: 'GET', path: '/api/model-providers', authStatus: 'oauth-confirmed', risk: 'R0', status: 'implemented' }),
  capability({ id: 'project.update', area: 'project-settings', action: 'update-project-settings', sourceTier: 'authenticated-client', method: 'PATCH', path: '/api/projects/:projectId', authStatus: 'unverified', risk: 'W1', status: 'discovered' }),
  capability({ id: 'project.repo-settings.get', area: 'project-repository', action: 'get-resolved-repository-settings', sourceTier: 'authenticated-client', method: 'GET', path: '/api/projects/:projectId/repo-settings', authStatus: 'unverified', risk: 'R0', status: 'discovered' }),
  capability({ id: 'project.environment.list', area: 'project-environment', action: 'list-variable-names', sourceTier: 'authenticated-client', method: 'GET', path: '/api/projects/:projectId/env-vars', authStatus: 'unverified', risk: 'R0', status: 'discovered', notes: 'Values must remain write-only and absent from normal output.' }),
  capability({ id: 'project.environment.set', area: 'project-environment', action: 'set-secret', sourceTier: 'authenticated-client', method: 'PUT', path: '/api/projects/:projectId/env-vars/:key', authStatus: 'unverified', risk: 'W2', status: 'discovered' }),
  capability({ id: 'project.environment.unset', area: 'project-environment', action: 'unset-secret', sourceTier: 'authenticated-client', method: 'DELETE', path: '/api/projects/:projectId/env-vars/:key', authStatus: 'unverified', risk: 'W2', status: 'discovered' }),
  capability({ id: 'project.prebuilds.get', area: 'project-sandbox', action: 'get-prebuild-status', sourceTier: 'authenticated-client', method: 'GET', path: '/api/projects/:projectId/prebuilds', authStatus: 'unverified', risk: 'R0', status: 'discovered' }),
  capability({ id: 'project.prebuilds.rebake', area: 'project-sandbox', action: 'rebake-prebuild', sourceTier: 'authenticated-client', method: 'POST', path: '/api/projects/:projectId/prebuilds/rebake', authStatus: 'unverified', risk: 'W2', status: 'discovered' }),
  capability({ id: 'mcp.catalog.list', area: 'project-mcp', action: 'list-catalog', sourceTier: 'authenticated-client', method: 'GET', path: '/api/mcp/catalog', authStatus: 'unverified', risk: 'R0', status: 'discovered' }),
  capability({
    id: 'mcp.auth.analyze',
    area: 'project-mcp',
    action: 'analyze-auth',
    sourceTier: 'authenticated-client',
    method: 'POST',
    path: '/api/mcp/auth-analysis',
    authStatus: 'unverified',
    risk: 'W2',
    status: 'blocked',
    payloadEvidence: 'Authenticated-client body is {url}; response is an auth-analysis union. No credential, project, or idempotency field is evidenced.',
    sideEffects: 'Hoplite is expected to contact a caller-selected external endpoint for authentication discovery; persistence is not evidenced.',
    notes: 'Blocked until CLI credential compatibility and Hoplite-side DNS, redirect, and rebinding controls are verified. The local mcp-endpoint-check command does not call this route.',
  }),
  capability({
    id: 'mcp.server.probe',
    area: 'project-mcp',
    action: 'probe-endpoint',
    sourceTier: 'authenticated-client',
    method: 'POST',
    path: '/api/mcp/probe',
    authStatus: 'unverified',
    risk: 'W2',
    status: 'blocked',
    payloadEvidence: 'Authenticated-client body is {url}; response projects connection, auth, transport, server-name, tool-count, and instructions metadata.',
    sideEffects: 'Hoplite is expected to contact a caller-selected external MCP endpoint; persistence is not evidenced.',
    notes: 'Blocked until CLI credential compatibility and Hoplite-side DNS, redirect, and rebinding controls are verified. The local mcp-endpoint-check command does not call this route.',
  }),
  capability({ id: 'mcp.servers.list', area: 'project-mcp', action: 'list-servers', sourceTier: 'authenticated-client', method: 'GET', path: '/api/mcp/servers', authStatus: 'unverified', risk: 'R0', status: 'discovered' }),
  capability({ id: 'mcp.servers.create', area: 'project-mcp', action: 'create-server', sourceTier: 'authenticated-client', method: 'POST', path: '/api/mcp/servers', authStatus: 'unverified', risk: 'W2', status: 'discovered' }),
  capability({ id: 'mcp.servers.update', area: 'project-mcp', action: 'update-server', sourceTier: 'authenticated-client', method: 'PATCH', path: '/api/mcp/servers/:serverId', authStatus: 'unverified', risk: 'W2', status: 'discovered' }),
  capability({ id: 'mcp.servers.delete', area: 'project-mcp', action: 'delete-server', sourceTier: 'authenticated-client', method: 'DELETE', path: '/api/mcp/servers/:serverId', authStatus: 'unverified', risk: 'W3', status: 'discovered' }),
  capability({ id: 'mcp.servers.oauth-start', area: 'project-mcp', action: 'start-oauth', sourceTier: 'authenticated-client', method: 'POST', path: '/api/mcp/servers/:serverId/oauth/start', authStatus: 'browser-session-only', risk: 'W2', status: 'blocked', notes: 'Provider consent remains an interactive browser handoff.' }),
  capability({ id: 'personal.memories.list', area: 'personalization', action: 'list-memories', sourceTier: 'authenticated-client', method: 'GET', path: '/api/agent-memories', authStatus: 'unverified', risk: 'R0', status: 'discovered' }),
  capability({ id: 'personal.skills.list', area: 'personalization', action: 'list-skills', sourceTier: 'authenticated-client', method: 'GET', path: '/api/user/skills', authStatus: 'unverified', risk: 'R0', status: 'discovered' }),
  capability({ id: 'workspace.sandbox-defaults.get', area: 'workspace', action: 'get-sandbox-defaults', sourceTier: 'authenticated-client', method: 'GET', path: '/api/orgs/sandbox-spec', authStatus: 'unverified', risk: 'R0', status: 'discovered' }),
  capability({ id: 'workspace.invitations.list', area: 'workspace-members', action: 'list-invitations', sourceTier: 'authenticated-client', method: 'GET', path: '/api/orgs/invitations', authStatus: 'browser-session-only', risk: 'R0', status: 'blocked' }),
  capability({ id: 'workspace.model-keys.list', area: 'workspace', action: 'get-provider-key-status', sourceTier: 'authenticated-client', method: 'GET', path: '/api/orgs/model-keys', authStatus: 'unverified', risk: 'R0', status: 'discovered' }),
  capability({ id: 'workspace.model-connections.list', area: 'integrations', action: 'list-model-connections', sourceTier: 'authenticated-client', method: 'GET', path: '/api/model-connections', authStatus: 'unverified', risk: 'R0', status: 'discovered' }),
  capability({ id: 'workspace.api-keys.create', area: 'workspace-api-keys', action: 'create-api-key', sourceTier: 'authenticated-client', method: 'POST', path: '/api/api-keys', authStatus: 'unverified', risk: 'W3', status: 'blocked', notes: 'One-time secret requires a dedicated non-stdout sink.' }),
  capability({ id: 'billing.routes', area: 'billing', action: 'discover-billing-routes', sourceTier: 'authenticated-client', method: 'GET', path: '/api/billing/*', authStatus: 'unverified', risk: 'R0', status: 'discovered', notes: 'Each exact read route must be evidenced before implementation.' }),
  capability({ id: 'integrations.routes', area: 'integrations', action: 'discover-provider-routes', sourceTier: 'authenticated-client', method: 'GET', path: '/api/{source-control,slack,linear,sentry,phone}/*', authStatus: 'unverified', risk: 'R0', status: 'discovered', notes: 'Provider mutations require exact per-provider contracts and consent handoffs.' }),
  capability({ id: 'project.delete', area: 'project-danger-zone', action: 'delete-project', sourceTier: 'authenticated-client', method: 'DELETE', path: '/api/projects/:projectId', authStatus: 'unverified', risk: 'W3', status: 'blocked', notes: 'Destructive action requires a server challenge or equivalent fresh human confirmation.' }),
];

function cloneIdentity(): CompatibilityIdentity {
  return JSON.parse(JSON.stringify(COMPATIBILITY_IDENTITY)) as CompatibilityIdentity;
}

export function compatibilitySnapshot(
  now = new Date(),
  area?: string,
): CompatibilitySnapshot {
  const normalizedArea = area?.trim().toLowerCase();
  const capabilities = COMPATIBILITY_REGISTRY
    .filter(entry => !normalizedArea || entry.area.toLowerCase() === normalizedArea)
    .map(entry => ({ ...entry }));
  return {
    identity: cloneIdentity(),
    generatedAt: now.toISOString(),
    ...(normalizedArea ? { filter: { area: normalizedArea } } : {}),
    capabilities,
  };
}

export function settingsCapabilitySnapshot(now = new Date()): CompatibilitySnapshot {
  return {
    ...compatibilitySnapshot(now),
    capabilities: COMPATIBILITY_REGISTRY
      .filter(entry => !['projects'].includes(entry.area))
      .map(entry => ({ ...entry })),
  };
}

export function compatibilityStatus(snapshot = compatibilitySnapshot()): Record<string, unknown> {
  const countBy = (key: 'status' | 'risk' | 'sourceTier' | 'authStatus'): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const entry of snapshot.capabilities) {
      const value = entry[key];
      counts[value] = (counts[value] ?? 0) + 1;
    }
    return counts;
  };
  return {
    identity: snapshot.identity,
    generatedAt: snapshot.generatedAt,
    ...(snapshot.filter ? { filter: snapshot.filter } : {}),
    capabilityCount: snapshot.capabilities.length,
    counts: {
      status: countBy('status'),
      risk: countBy('risk'),
      sourceTier: countBy('sourceTier'),
      authStatus: countBy('authStatus'),
    },
    capabilities: snapshot.capabilities,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function snapshotFromUnknown(value: unknown): CompatibilitySnapshot {
  if (!isRecord(value)) throw new Error('Compatibility baseline must be a JSON object');
  const candidate = isRecord(value.identity) && Array.isArray(value.capabilities)
    ? value
    : isRecord(value.snapshot)
      ? value.snapshot
      : value;
  if (!isRecord(candidate.identity) || !Array.isArray(candidate.capabilities)) {
    throw new Error('Compatibility baseline is missing identity or capabilities');
  }
  const capabilities: CompatibilityCapability[] = [];
  for (const item of candidate.capabilities.slice(0, 1_000)) {
    if (!isRecord(item) || typeof item.id !== 'string' || !CAPABILITY_ID_RE.test(item.id)) {
      throw new Error('Compatibility baseline contains an invalid capability');
    }
    capabilities.push(item as unknown as CompatibilityCapability);
  }
  let filter: CompatibilitySnapshot['filter'];
  if (candidate.filter !== undefined) {
    if (!isRecord(candidate.filter) || typeof candidate.filter.area !== 'string' || !candidate.filter.area.trim()) {
      throw new Error('Compatibility baseline contains an invalid area filter');
    }
    filter = { area: candidate.filter.area.trim().toLowerCase() };
  }
  return {
    identity: candidate.identity as CompatibilityIdentity,
    generatedAt: typeof candidate.generatedAt === 'string' ? candidate.generatedAt : 'unknown',
    ...(filter ? { filter } : {}),
    capabilities,
  };
}

function capabilitySignature(entry: CompatibilityCapability): string {
  return JSON.stringify({
    area: entry.area,
    action: entry.action,
    sourceTier: entry.sourceTier,
    method: entry.method,
    path: entry.path,
    authStatus: entry.authStatus,
    risk: entry.risk,
    status: entry.status,
    lastVerified: entry.lastVerified,
    payloadEvidence: entry.payloadEvidence,
    callerEvidence: entry.callerEvidence,
    sideEffects: entry.sideEffects,
    notes: entry.notes ?? null,
  });
}

export function diffCompatibility(
  baselineValue: unknown,
  current?: CompatibilitySnapshot,
): Record<string, unknown> {
  const baseline = snapshotFromUnknown(baselineValue);
  const expectedArea = baseline.filter?.area;
  const resolvedCurrent = current ?? compatibilitySnapshot(new Date(), expectedArea);
  if ((resolvedCurrent.filter?.area ?? null) !== (expectedArea ?? null)) {
    throw new Error('Compatibility baseline and current snapshot area filters do not match');
  }
  const before = new Map(baseline.capabilities.map(entry => [entry.id, entry]));
  const after = new Map(resolvedCurrent.capabilities.map(entry => [entry.id, entry]));
  const added = [...after.keys()].filter(id => !before.has(id)).sort();
  const removed = [...before.keys()].filter(id => !after.has(id)).sort();
  const changed = [...after.keys()]
    .filter(id => before.has(id) && capabilitySignature(before.get(id)!) !== capabilitySignature(after.get(id)!))
    .sort();
  const identityChanged = JSON.stringify(baseline.identity) !== JSON.stringify(resolvedCurrent.identity);
  return {
    changed: identityChanged || added.length > 0 || removed.length > 0 || changed.length > 0,
    identityChanged,
    baselineGeneratedAt: baseline.generatedAt,
    currentGeneratedAt: resolvedCurrent.generatedAt,
    filter: expectedArea ? { area: expectedArea } : null,
    added,
    removed,
    modified: changed,
  };
}

export function loadCompatibilityBaseline(path: string): unknown {
  const metadata = statSync(path);
  if (!metadata.isFile()) throw new Error('Compatibility baseline must be a regular file');
  if (metadata.size > 512 * 1024) throw new Error('Compatibility baseline exceeds 512 KB');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported fields: ${unexpected.join(', ')}`);
}

function requiredPolicyId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !POLICY_ID_RE.test(value)) {
    throw new Error(`Resource policy ${label} is invalid`);
  }
  return value;
}

function requiredTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Resource policy ${label} must be an ISO timestamp`);
  }
  return Date.parse(value);
}

export function parseResourcePolicy(value: unknown, now = Date.now()): ResourcePolicy {
  if (!isRecord(value)) throw new Error('Resource policy must be a JSON object');
  requireExactKeys(value, ['version', 'owner', 'origins', 'resources', 'issuedAt', 'expiresAt'], 'Resource policy');
  if (value.version !== 1) throw new Error('Unsupported resource policy version');
  if (!isRecord(value.owner)) throw new Error('Resource policy owner is required');
  requireExactKeys(value.owner, ['accountId', 'workspaceId'], 'Resource policy owner');
  const owner = {
    accountId: requiredPolicyId(value.owner.accountId, 'account id'),
    workspaceId: requiredPolicyId(value.owner.workspaceId, 'workspace id'),
  };
  if (!Array.isArray(value.origins) || value.origins.length === 0 || value.origins.length > 8) {
    throw new Error('Resource policy must contain between 1 and 8 origins');
  }
  const origins = value.origins.map(raw => {
    if (typeof raw !== 'string') throw new Error('Resource policy origin must be a string');
    const origin = new URL(raw);
    if (origin.origin !== raw || (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname))) {
      throw new Error('Resource policy origins must be exact HTTPS or loopback origins');
    }
    return origin.origin;
  });
  if (new Set(origins).size !== origins.length) throw new Error('Resource policy origins must be unique');
  if (!Array.isArray(value.resources) || value.resources.length === 0 || value.resources.length > 100) {
    throw new Error('Resource policy must contain between 1 and 100 resources');
  }
  const resources = value.resources.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Resource policy resource ${index} must be an object`);
    requireExactKeys(raw, ['kind', 'id', 'capabilities', 'riskCeiling'], `Resource policy resource ${index}`);
    if (raw.kind !== 'project' && raw.kind !== 'workspace') {
      throw new Error(`Resource policy resource ${index} has an unsupported kind`);
    }
    const kind: 'project' | 'workspace' = raw.kind;
    if (!Array.isArray(raw.capabilities) || raw.capabilities.length === 0 || raw.capabilities.length > 100) {
      throw new Error(`Resource policy resource ${index} must contain between 1 and 100 capabilities`);
    }
    const capabilities = raw.capabilities.map(item => {
      if (typeof item !== 'string' || !CAPABILITY_ID_RE.test(item)) {
        throw new Error(`Resource policy resource ${index} contains an invalid capability`);
      }
      return item;
    });
    if (new Set(capabilities).size !== capabilities.length) {
      throw new Error(`Resource policy resource ${index} capabilities must be unique`);
    }
    if (!['W1', 'W2', 'W3'].includes(String(raw.riskCeiling))) {
      throw new Error(`Resource policy resource ${index} has an invalid risk ceiling`);
    }
    for (const capabilityId of capabilities) {
      const registered = COMPATIBILITY_REGISTRY.find(entry => entry.id === capabilityId);
      if (!registered || registered.risk === 'R0') {
        throw new Error(`Resource policy resource ${index} contains an unknown or non-write capability`);
      }
    }
    return {
      kind,
      id: requiredPolicyId(raw.id, `resource ${index} id`),
      capabilities,
      riskCeiling: raw.riskCeiling as 'W1' | 'W2' | 'W3',
    };
  });
  const resourceKeys = resources.map(resource => `${resource.kind}:${resource.id}`);
  if (new Set(resourceKeys).size !== resourceKeys.length) {
    throw new Error('Resource policy resources must be unique');
  }
  for (const resource of resources) {
    if (resource.kind === 'workspace' && resource.id !== owner.workspaceId) {
      throw new Error('Workspace resource must match the policy owner workspace');
    }
  }
  const issuedAt = requiredTimestamp(value.issuedAt, 'issuedAt');
  const expiresAt = requiredTimestamp(value.expiresAt, 'expiresAt');
  if (issuedAt > now + 5 * 60_000) throw new Error('Resource policy issuedAt is in the future');
  if (expiresAt <= now) throw new Error('Resource policy is expired');
  if (expiresAt <= issuedAt) throw new Error('Resource policy expiresAt must be after issuedAt');
  if (expiresAt - issuedAt > 24 * 60 * 60_000) throw new Error('Resource policy lifetime exceeds 24 hours');
  return {
    version: 1,
    owner,
    origins,
    resources,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function loadResourcePolicy(path: string, now = Date.now()): ResourcePolicy {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isRecord(error) && error.code === 'ELOOP') {
      throw new Error('Resource policy must be a regular non-symlink file');
    }
    throw error;
  }
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error('Resource policy must be a regular non-symlink file');
    const permissionMode = metadata.mode & 0o777;
    if (permissionMode !== 0o400 && permissionMode !== 0o600) {
      throw new Error('Resource policy permissions must be owner-only (0400 or 0600)');
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new Error('Resource policy must be owned by the current user');
    }
    if (metadata.size > POLICY_MAX_BYTES) throw new Error('Resource policy exceeds 32 KB');
    const raw = readFileSync(descriptor, 'utf8');
    return parseResourcePolicy(JSON.parse(raw) as unknown, now);
  } finally {
    closeSync(descriptor);
  }
}

export function validateResourcePolicyGrant(
  policy: ResourcePolicy,
  request: ResourcePolicyGrantRequest,
  now = Date.now(),
): Record<string, unknown> {
  if (Date.parse(policy.expiresAt) <= now) throw new Error('Resource policy is expired');
  if (request.accountId !== policy.owner.accountId || request.workspaceId !== policy.owner.workspaceId) {
    throw new Error('Authenticated owner does not match the resource policy');
  }
  let origin: string;
  try {
    origin = new URL(request.origin).origin;
  } catch {
    throw new Error('Requested origin is invalid');
  }
  if (origin !== request.origin || !policy.origins.includes(origin)) {
    throw new Error('Requested origin is not allowed by the resource policy');
  }
  const resource = policy.resources.find(candidate => (
    candidate.kind === request.kind && candidate.id === request.resourceId
  ));
  if (!resource) throw new Error('Requested resource is not allowed by the resource policy');
  if (!resource.capabilities.includes(request.capability)) {
    throw new Error('Requested capability is not allowed by the resource policy');
  }
  if ('risk' in request) {
    throw new Error('Requested risk must not be caller supplied; it is derived from the compatibility registry');
  }
  const registered = COMPATIBILITY_REGISTRY.find(entry => entry.id === request.capability);
  if (!registered || registered.risk === 'R0') {
    throw new Error('Requested capability is not a registered write capability');
  }
  const riskOrder = { W1: 1, W2: 2, W3: 3 } as const;
  const risk = registered.risk;
  if (riskOrder[risk] > riskOrder[resource.riskCeiling]) {
    throw new Error('Requested risk exceeds the resource policy ceiling');
  }
  return {
    authorized: true,
    accountId: request.accountId,
    workspaceId: request.workspaceId,
    origin,
    resource: { kind: resource.kind, id: resource.id },
    capability: request.capability,
    risk,
    expiresAt: policy.expiresAt,
  };
}

export function resourcePolicySummary(policy: ResourcePolicy): Record<string, unknown> {
  return {
    valid: true,
    version: policy.version,
    owner: policy.owner,
    origins: policy.origins,
    issuedAt: policy.issuedAt,
    expiresAt: policy.expiresAt,
    resources: policy.resources.map(resource => ({
      kind: resource.kind,
      id: resource.id,
      capabilityCount: resource.capabilities.length,
      capabilities: resource.capabilities,
      riskCeiling: resource.riskCeiling,
    })),
  };
}
