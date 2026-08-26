import type {
  CliCommandDefinition,
  CommandResult,
  LocalCommandContext,
} from './command-registry';

export const ACCOUNT_SETTINGS_AREAS = [
  'profile',
  'personalization',
  'preferences',
] as const;

export type AccountSettingsArea = typeof ACCOUNT_SETTINGS_AREAS[number];

export type AccountSettingsCapability =
  | 'profile_session_read'
  | 'profile_session_write'
  | 'personalization_session_read'
  | 'personalization_session_write'
  | 'personal_memories_inventory'
  | 'personal_memories_write'
  | 'personal_skills_inventory'
  | 'personal_skills_write'
  | 'device_preferences_read'
  | 'device_preferences_write';

export type AccountSettingsAuth =
  | 'browser_session_only'
  | 'oauth_compatibility_unverified'
  | 'not_applicable_device_local';

export type AccountSettingsPersistence =
  | 'hoplite_account_cloud'
  | 'hoplite_personal_context_cloud'
  | 'browser_device_local';

export type AccountSettingsStatus =
  | 'blocked_no_cli_contract'
  | 'separate_pr_dependency'
  | 'browser_device_only';

export type AccountSettingsEvidenceTier =
  | 'verified_static_client'
  | 'verified_runtime_ui';

export type AccountSettingsOperation = 'read' | 'write';
export type AccountSettingsRisk = 'R0' | 'W1' | 'W2' | 'local_device';
export type AccountSettingsDependency = 'none' | 'pull_request_10_not_in_branch';
export type AccountSettingsImplementedCommand = 'account-settings-capabilities';

export type AccountSettingsCapabilityRecord = {
  area: AccountSettingsArea;
  capability: AccountSettingsCapability;
  operation: AccountSettingsOperation;
  auth: AccountSettingsAuth;
  persistence: AccountSettingsPersistence;
  status: AccountSettingsStatus;
  risk: AccountSettingsRisk;
  evidenceTiers: readonly AccountSettingsEvidenceTier[];
  dependency: AccountSettingsDependency;
  implementedCommands: readonly AccountSettingsImplementedCommand[];
};

// This is deliberately a fixed, tenant-free gap registry. It records what the
// delivered client proves without retaining account values, browser state, or
// proposed command names. Empty command arrays mean the action is unavailable
// on this branch; they are not an invitation to guess a browser contract.
export const ACCOUNT_SETTINGS_CAPABILITY_REGISTRY: readonly AccountSettingsCapabilityRecord[] = [
  {
    area: 'profile',
    capability: 'profile_session_read',
    operation: 'read',
    auth: 'browser_session_only',
    persistence: 'hoplite_account_cloud',
    status: 'blocked_no_cli_contract',
    risk: 'R0',
    evidenceTiers: ['verified_static_client', 'verified_runtime_ui'],
    dependency: 'none',
    implementedCommands: [],
  },
  {
    area: 'profile',
    capability: 'profile_session_write',
    operation: 'write',
    auth: 'browser_session_only',
    persistence: 'hoplite_account_cloud',
    status: 'blocked_no_cli_contract',
    risk: 'W1',
    evidenceTiers: ['verified_static_client', 'verified_runtime_ui'],
    dependency: 'none',
    implementedCommands: [],
  },
  {
    area: 'personalization',
    capability: 'personalization_session_read',
    operation: 'read',
    auth: 'browser_session_only',
    persistence: 'hoplite_account_cloud',
    status: 'blocked_no_cli_contract',
    risk: 'R0',
    evidenceTiers: ['verified_static_client'],
    dependency: 'none',
    implementedCommands: [],
  },
  {
    area: 'personalization',
    capability: 'personalization_session_write',
    operation: 'write',
    auth: 'browser_session_only',
    persistence: 'hoplite_account_cloud',
    status: 'blocked_no_cli_contract',
    risk: 'W1',
    evidenceTiers: ['verified_static_client'],
    dependency: 'none',
    implementedCommands: [],
  },
  {
    area: 'personalization',
    capability: 'personal_memories_inventory',
    operation: 'read',
    auth: 'oauth_compatibility_unverified',
    persistence: 'hoplite_personal_context_cloud',
    status: 'separate_pr_dependency',
    risk: 'R0',
    evidenceTiers: ['verified_static_client'],
    dependency: 'pull_request_10_not_in_branch',
    implementedCommands: [],
  },
  {
    area: 'personalization',
    capability: 'personal_memories_write',
    operation: 'write',
    auth: 'oauth_compatibility_unverified',
    persistence: 'hoplite_personal_context_cloud',
    status: 'blocked_no_cli_contract',
    risk: 'W2',
    evidenceTiers: ['verified_static_client'],
    dependency: 'none',
    implementedCommands: [],
  },
  {
    area: 'personalization',
    capability: 'personal_skills_inventory',
    operation: 'read',
    auth: 'oauth_compatibility_unverified',
    persistence: 'hoplite_personal_context_cloud',
    status: 'separate_pr_dependency',
    risk: 'R0',
    evidenceTiers: ['verified_static_client'],
    dependency: 'pull_request_10_not_in_branch',
    implementedCommands: [],
  },
  {
    area: 'personalization',
    capability: 'personal_skills_write',
    operation: 'write',
    auth: 'oauth_compatibility_unverified',
    persistence: 'hoplite_personal_context_cloud',
    status: 'blocked_no_cli_contract',
    risk: 'W2',
    evidenceTiers: ['verified_static_client'],
    dependency: 'none',
    implementedCommands: [],
  },
  {
    area: 'preferences',
    capability: 'device_preferences_read',
    operation: 'read',
    auth: 'not_applicable_device_local',
    persistence: 'browser_device_local',
    status: 'browser_device_only',
    risk: 'local_device',
    evidenceTiers: ['verified_static_client'],
    dependency: 'none',
    implementedCommands: [],
  },
  {
    area: 'preferences',
    capability: 'device_preferences_write',
    operation: 'write',
    auth: 'not_applicable_device_local',
    persistence: 'browser_device_local',
    status: 'browser_device_only',
    risk: 'local_device',
    evidenceTiers: ['verified_static_client'],
    dependency: 'none',
    implementedCommands: [],
  },
];

function validateInvocation(context: LocalCommandContext): AccountSettingsArea | undefined {
  if (context.positionals.length > 0) {
    throw new Error('account-settings-capabilities does not accept positional arguments');
  }
  for (const flag of context.flags.keys()) {
    if (flag !== 'area') {
      throw new Error('account-settings-capabilities supports only the optional --area flag');
    }
  }
  const area = context.flags.get('area');
  if (area === undefined) return undefined;
  if (!ACCOUNT_SETTINGS_AREAS.some(candidate => candidate === area)) {
    throw new Error('account-settings-capabilities --area must be exactly profile, personalization, or preferences');
  }
  return area as AccountSettingsArea;
}

export function projectAccountSettingsCapability(
  entry: AccountSettingsCapabilityRecord,
): AccountSettingsCapabilityRecord {
  return {
    area: entry.area,
    capability: entry.capability,
    operation: entry.operation,
    auth: entry.auth,
    persistence: entry.persistence,
    status: entry.status,
    risk: entry.risk,
    evidenceTiers: [...entry.evidenceTiers],
    dependency: entry.dependency,
    implementedCommands: [...entry.implementedCommands],
  };
}

export function accountSettingsCapabilities(context: LocalCommandContext): CommandResult {
  const area = validateInvocation(context);
  const capabilities = ACCOUNT_SETTINGS_CAPABILITY_REGISTRY
    .filter(entry => area === undefined || entry.area === area)
    .map(projectAccountSettingsCapability);
  return {
    command: 'account-settings-capabilities',
    mode: 'local_evidence_only',
    privacyPolicy: 'fixed_metadata_only',
    implementedCommands: ['account-settings-capabilities'],
    ...(area === undefined ? {} : { filter: { area } }),
    capabilities,
  };
}

export const accountSettingsCapabilityCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'account-settings-capabilities',
    description: 'Show fixed local capability boundaries for profile, personalization, and preferences; supports exact --area',
    transport: 'local',
    run: accountSettingsCapabilities,
  },
];
