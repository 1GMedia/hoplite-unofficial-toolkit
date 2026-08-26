import type { CliCommandDefinition } from './command-registry';
import {
  compatibilitySnapshot,
  compatibilityStatus,
  diffCompatibility,
  loadCompatibilityBaseline,
  loadResourcePolicy,
  resourcePolicySummary,
  settingsCapabilitySnapshot,
} from './compatibility';

export const foundationCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'settings-capabilities',
    description: 'Print the sanitized evidence registry for discovered settings capabilities; supports --area',
    transport: 'local',
    run: ({ flags }) => {
      const snapshot = settingsCapabilitySnapshot();
      const area = flags.get('area')?.trim().toLowerCase();
      return area
        ? { ...snapshot, capabilities: snapshot.capabilities.filter(entry => entry.area.toLowerCase() === area) }
        : snapshot;
    },
  },
  {
    name: 'compatibility-status',
    description: 'Print bounded source, auth, risk, and implementation status for the compatibility registry',
    transport: 'local',
    run: ({ flags }) => compatibilityStatus(compatibilitySnapshot(new Date(), flags.get('area'))),
  },
  {
    name: 'compatibility-diff',
    description: 'Compare the current registry with a prior JSON snapshot supplied via --baseline',
    transport: 'local',
    run: ({ flags }) => {
      const baselinePath = flags.get('baseline');
      if (!baselinePath) throw new Error('compatibility-diff requires --baseline <snapshot.json>');
      return diffCompatibility(loadCompatibilityBaseline(baselinePath));
    },
  },
  {
    name: 'resource-policy-check',
    description: 'Validate an owner-only, expiring future-write policy supplied via --file without changing Hoplite state',
    transport: 'local',
    run: ({ flags }) => {
      const policyPath = flags.get('file');
      if (!policyPath) throw new Error('resource-policy-check requires --file <policy.json>');
      return resourcePolicySummary(loadResourcePolicy(policyPath));
    },
  },
];
