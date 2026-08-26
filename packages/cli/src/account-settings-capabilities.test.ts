import { describe, expect, test } from 'bun:test';

import {
  ACCOUNT_SETTINGS_CAPABILITY_REGISTRY,
  accountSettingsCapabilities,
  accountSettingsCapabilityCommandDefinitions,
  projectAccountSettingsCapability,
} from './account-settings-capabilities';
import { run } from './index';

const AREAS = new Set(['profile', 'personalization', 'preferences']);
const CAPABILITIES = new Set([
  'profile_session_read',
  'profile_session_write',
  'personalization_session_read',
  'personalization_session_write',
  'personal_memories_inventory',
  'personal_memories_write',
  'personal_skills_inventory',
  'personal_skills_write',
  'device_preferences_read',
  'device_preferences_write',
]);
const AUTH = new Set([
  'browser_session_only',
  'oauth_compatibility_unverified',
  'not_applicable_device_local',
]);
const PERSISTENCE = new Set([
  'hoplite_account_cloud',
  'hoplite_personal_context_cloud',
  'browser_device_local',
]);
const STATUS = new Set([
  'blocked_no_cli_contract',
  'separate_pr_dependency',
  'browser_device_only',
]);
const EVIDENCE = new Set(['verified_static_client', 'verified_runtime_ui']);
const TOP_LEVEL_KEYS = [
  'command',
  'mode',
  'privacyPolicy',
  'implementedCommands',
  'capabilities',
];
const FILTERED_TOP_LEVEL_KEYS = [
  'command',
  'mode',
  'privacyPolicy',
  'implementedCommands',
  'filter',
  'capabilities',
];
const CAPABILITY_RECORD_KEYS = [
  'area',
  'capability',
  'operation',
  'auth',
  'persistence',
  'status',
  'risk',
  'evidenceTiers',
  'dependency',
  'implementedCommands',
];

describe('account settings capability gap analysis', () => {
  test('returns fixed tenant-free metadata and implemented command names only', () => {
    const result = accountSettingsCapabilities({ positionals: [], flags: new Map() });
    expect(result).toMatchObject({
      command: 'account-settings-capabilities',
      mode: 'local_evidence_only',
      privacyPolicy: 'fixed_metadata_only',
      implementedCommands: ['account-settings-capabilities'],
    });
    expect(Object.keys(result)).toEqual(TOP_LEVEL_KEYS);
    const records = result.capabilities as Array<Record<string, unknown>>;
    expect(records).toHaveLength(ACCOUNT_SETTINGS_CAPABILITY_REGISTRY.length);
    expect(new Set(records.map(record => record.capability)).size).toBe(records.length);
    for (const record of records) {
      expect(Object.keys(record)).toEqual(CAPABILITY_RECORD_KEYS);
      expect(AREAS.has(String(record.area))).toBe(true);
      expect(CAPABILITIES.has(String(record.capability))).toBe(true);
      expect(AUTH.has(String(record.auth))).toBe(true);
      expect(PERSISTENCE.has(String(record.persistence))).toBe(true);
      expect(STATUS.has(String(record.status))).toBe(true);
      expect((record.evidenceTiers as string[]).every(tier => EVIDENCE.has(tier))).toBe(true);
      expect(record.implementedCommands).toEqual([]);
    }
  });

  test('projects exact keys and drops adversarial account-shaped fields', () => {
    const arbitraryValues = [
      'Fixture Display Name',
      'acct_private_fixture_123',
      'arbitrary private notes that must not be projected',
    ];
    const adversarialFixture = {
      ...ACCOUNT_SETTINGS_CAPABILITY_REGISTRY[0]!,
      displayName: arbitraryValues[0],
      accountId: arbitraryValues[1],
      notes: arbitraryValues[2],
      nested: { displayName: arbitraryValues[0] },
    };
    const projected = projectAccountSettingsCapability(adversarialFixture);
    expect(Object.keys(projected)).toEqual(CAPABILITY_RECORD_KEYS);
    const serialized = JSON.stringify(projected);
    for (const value of arbitraryValues) expect(serialized).not.toContain(value);
    expect(serialized).not.toMatch(/displayName|accountId|notes|nested/i);
  });

  test('never returns personal values, rows, identifiers, text, lengths, or digests', () => {
    const fixtureValues = [
      'Fixture Person',
      'fixture-person@example.test',
      'https://private.example/avatar.png',
      'Always use the private fixture instructions',
      'fixture preference value',
      'mem_fixture_private_identifier',
      'skill_fixture_private_identifier',
      'fixture private memory body',
      'fixture private skill body',
    ];
    const serialized = JSON.stringify(accountSettingsCapabilities({ positionals: [], flags: new Map() }));
    for (const value of fixtureValues) expect(serialized).not.toContain(value);
    expect(serialized).not.toMatch(/(?:row|item|record)Count|(?:byte|character)?Length|sha(?:256)?|digest/i);
    expect(serialized).not.toMatch(/\/api\/auth\/session|better-auth:|\/api\/(?:agent-memories|user\/skills)/i);
  });

  test('filters only the three exact supported areas', () => {
    for (const area of AREAS) {
      const result = accountSettingsCapabilities({
        positionals: [],
        flags: new Map([['area', area]]),
      });
      expect(Object.keys(result)).toEqual(FILTERED_TOP_LEVEL_KEYS);
      expect(result.filter).toEqual({ area });
      expect(Object.keys(result.filter as Record<string, unknown>)).toEqual(['area']);
      const records = result.capabilities as Array<Record<string, unknown>>;
      expect(records.length).toBeGreaterThan(0);
      expect(records.every(record => record.area === area)).toBe(true);
    }
    for (const area of ['', 'true', 'Profile', ' profile', 'preferences ', 'account']) {
      expect(() => accountSettingsCapabilities({
        positionals: [],
        flags: new Map([['area', area]]),
      })).toThrow('--area must be exactly');
    }
  });

  test('keeps cloud writes blocked and device preferences separate from cloud state', () => {
    const result = accountSettingsCapabilities({ positionals: [], flags: new Map() });
    const records = result.capabilities as Array<Record<string, unknown>>;
    const cloudWrites = records.filter(record => (
      record.operation === 'write' && record.persistence !== 'browser_device_local'
    ));
    expect(cloudWrites.length).toBeGreaterThan(0);
    expect(cloudWrites.every(record => (
      record.status === 'blocked_no_cli_contract'
      && (record.risk === 'W1' || record.risk === 'W2')
      && (record.implementedCommands as unknown[]).length === 0
    ))).toBe(true);

    const preferences = records.filter(record => record.area === 'preferences');
    expect(preferences).toHaveLength(2);
    expect(preferences.every(record => (
      record.auth === 'not_applicable_device_local'
      && record.persistence === 'browser_device_local'
      && record.status === 'browser_device_only'
      && record.risk === 'local_device'
    ))).toBe(true);
  });

  test('records PR 10 as a missing dependency without duplicating its commands', () => {
    const dependencies = ACCOUNT_SETTINGS_CAPABILITY_REGISTRY.filter(
      record => record.dependency === 'pull_request_10_not_in_branch',
    );
    expect(dependencies.map(record => record.capability)).toEqual([
      'personal_memories_inventory',
      'personal_skills_inventory',
    ]);
    expect(dependencies.every(record => (
      record.status === 'separate_pr_dependency' && record.implementedCommands.length === 0
    ))).toBe(true);
  });

  test('runs before OAuth/client creation and appears in help', async () => {
    expect(accountSettingsCapabilityCommandDefinitions).toHaveLength(1);
    expect(accountSettingsCapabilityCommandDefinitions[0]).toMatchObject({
      name: 'account-settings-capabilities',
      transport: 'local',
    });
    const previousOAuthPath = process.env.HOPLITE_OAUTH_PATH;
    const previousApiKey = process.env.HOPLITE_API_KEY;
    process.env.HOPLITE_OAUTH_PATH = '/definitely/missing/account-settings-oauth.json';
    delete process.env.HOPLITE_API_KEY;
    try {
      const result = await run(['account-settings-capabilities', '--area', 'profile']);
      expect(result).toMatchObject({ mode: 'local_evidence_only' });
      const help = await run(['help']);
      expect((help.commands as Record<string, string>)['account-settings-capabilities'])
        .toContain('fixed local capability boundaries');
    } finally {
      if (previousOAuthPath === undefined) delete process.env.HOPLITE_OAUTH_PATH;
      else process.env.HOPLITE_OAUTH_PATH = previousOAuthPath;
      if (previousApiKey === undefined) delete process.env.HOPLITE_API_KEY;
      else process.env.HOPLITE_API_KEY = previousApiKey;
    }
  });

  test('rejects positional arguments and every unsupported flag locally', async () => {
    expect(() => accountSettingsCapabilities({ positionals: ['profile'], flags: new Map() }))
      .toThrow('does not accept positional arguments');
    const adversarialFlag = 'accountId=acct_private_fixture_arbitrary_notes';
    const expectedError = 'account-settings-capabilities supports only the optional --area flag';
    expect(() => accountSettingsCapabilities({
      positionals: [],
      flags: new Map([[adversarialFlag, 'Fixture Display Name']]),
    })).toThrow(expectedError);
    try {
      await run(['account-settings-capabilities', `--${adversarialFlag}`]);
      throw new Error('expected unsupported flag rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(expectedError);
      expect((error as Error).message).not.toContain(adversarialFlag);
      expect((error as Error).message).not.toContain('Fixture Display Name');
    }
    await expect(run(['account-settings-capabilities', '--area'])).rejects.toThrow('--area must be exactly');
  });
});
