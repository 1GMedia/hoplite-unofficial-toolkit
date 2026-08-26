import type { CliCommandDefinition, LocalCommandContext } from './command-registry';

const CAPABILITY = {
  CREATE: 'workspace-api-key-create',
  LIST: 'workspace-api-key-list',
  REVOKE: 'workspace-api-key-revoke',
} as const;

const AUTHENTICATION = {
  OWNER_ADMIN_PROOF_REQUIRED: 'owner-admin-proof-required',
  UNVERIFIED: 'unverified',
} as const;

const SECRET_SINK_REQUIREMENT = {
  KEYCHAIN_OR_OWNER_ONLY_0600_FILE: 'keychain-or-owner-only-0600-file',
  NOT_APPLICABLE: 'not-applicable',
} as const;

const IMPLEMENTATION_STATUS = {
  BLOCKED_MISSING_CREATION_GATES: 'blocked-missing-contract-authorization-isolation-and-sink',
  UNREGISTERED_BLOCKED: 'unregistered-blocked',
} as const;

const RISK = {
  READ: 'R0',
  CREDENTIAL_OR_DESTRUCTIVE_WRITE: 'W3',
} as const;

const WORKSPACE_API_KEY_CAPABILITIES = [
  {
    capability: CAPABILITY.CREATE,
    authentication: AUTHENTICATION.OWNER_ADMIN_PROOF_REQUIRED,
    secretSinkRequirement: SECRET_SINK_REQUIREMENT.KEYCHAIN_OR_OWNER_ONLY_0600_FILE,
    implementationStatus: IMPLEMENTATION_STATUS.BLOCKED_MISSING_CREATION_GATES,
    risk: RISK.CREDENTIAL_OR_DESTRUCTIVE_WRITE,
  },
  {
    capability: CAPABILITY.LIST,
    authentication: AUTHENTICATION.UNVERIFIED,
    secretSinkRequirement: SECRET_SINK_REQUIREMENT.NOT_APPLICABLE,
    implementationStatus: IMPLEMENTATION_STATUS.UNREGISTERED_BLOCKED,
    risk: RISK.READ,
  },
  {
    capability: CAPABILITY.REVOKE,
    authentication: AUTHENTICATION.UNVERIFIED,
    secretSinkRequirement: SECRET_SINK_REQUIREMENT.NOT_APPLICABLE,
    implementationStatus: IMPLEMENTATION_STATUS.UNREGISTERED_BLOCKED,
    risk: RISK.CREDENTIAL_OR_DESTRUCTIVE_WRITE,
  },
] as const;

function rejectArguments({ positionals, flags }: LocalCommandContext): void {
  if (positionals.length > 0 || flags.size > 0) {
    throw new Error('workspace-api-key-capabilities accepts no positionals or flags');
  }
}

export function workspaceApiKeyCapabilities(): Record<string, unknown> {
  return {
    capabilities: WORKSPACE_API_KEY_CAPABILITIES.map(capability => ({ ...capability })),
  };
}

export const workspaceApiKeyCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'workspace-api-key-capabilities',
    description: 'Report fixed local-only workspace API-key capability enums without inspecting credentials',
    transport: 'local',
    validate: rejectArguments,
    run: workspaceApiKeyCapabilities,
  },
];
