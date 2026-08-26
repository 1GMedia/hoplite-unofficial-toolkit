import { describe, expect, test } from 'bun:test';

import { redactAndBound, redactSecrets, redactText, safeBoundedString } from './output-safety';
import { sanitizeFeatureResult } from './project-settings-commands';

describe('shared output safety', () => {
  test('redacts quoted JSON sensitive keys and camelCase variants without echoing values', () => {
    const fixtures = [
      ['{"api_key":"fixture-json-api-key"}', 'fixture-json-api-key'],
      ['{"apiKey":"fixture-json-api-key-camel"}', 'fixture-json-api-key-camel'],
      ['{"accessToken":"fixture-json-access-token"}', 'fixture-json-access-token'],
      ['{"refresh_token":"fixture-json-refresh-token"}', 'fixture-json-refresh-token'],
      ['{"password":"fixture json password"}', 'fixture json password'],
      ['{"client_secret":"fixture-json-client-secret"}', 'fixture-json-client-secret'],
      ['{"authorization":"Bearer fixture-json-bearer"}', 'fixture-json-bearer'],
      ['{"token":"fixture-json-token"}', 'fixture-json-token'],
      ['{"credential":"https://user:pass@example.test/private"}', 'example.test'],
      ["{'loginUrl':'https://example.test/login?token=fixture-login'}", 'fixture-login'],
    ] as const;

    for (const [input, secret] of fixtures) {
      const output = redactText(input);
      expect(output).not.toContain(secret);
      expect(output).toContain('[redacted]');
    }
  });

  test('is strictly idempotent for existing redaction and URL placeholders', () => {
    const fixtures = [
      'Authorization: [redacted]',
      'authorization="[redacted]"',
      '{"api_key":"[redacted]"}',
      '{"accessToken":"[redacted]","credential":"[url]"}',
      'login_url=[url]',
      'Already safe: [redacted] and [url]',
    ];

    for (const fixture of fixtures) {
      expect(redactText(fixture)).toBe(fixture);
      expect(redactText(redactText(fixture))).toBe(fixture);
      expect(safeBoundedString(safeBoundedString(fixture, 1_000), 1_000)).toBe(fixture);
      expect(redactAndBound(redactAndBound(fixture, 1_000).value, 1_000).value).toBe(fixture);
    }

    const structured = {
      authorization: 'Authorization: [redacted]',
      values: ['{"apiKey":"[redacted]"}', '[url]'],
    };
    const once = sanitizeFeatureResult(structured);
    const twice = sanitizeFeatureResult(once);
    expect(twice).toEqual(once);
    expect(twice).toEqual(structured);
  });

  test('preserves Bearer and Basic authorization placeholders across colon and equal forms', () => {
    const fixtures = [
      'Authorization: Bearer [redacted]',
      'Authorization=Bearer [redacted]',
      'authorization: Basic [redacted]',
      'authorization=Basic [redacted]',
    ];

    for (const fixture of fixtures) {
      const once = redactText(fixture);
      const twice = redactText(once);
      expect(once).toBe(fixture);
      expect(twice).toBe(once);
      expect((once.match(/\[redacted\]/g) ?? []).length).toBe(1);
      expect(once).not.toContain(']]');
    }
  });

  test('redactSecrets produces one stable authorization marker for known Bearer and Basic secrets', () => {
    const knownSecret = 'fixture-known-authorization-secret';
    const fixtures = [
      `Authorization: Bearer ${knownSecret}`,
      `Authorization=Bearer ${knownSecret}`,
      `authorization: Basic ${knownSecret}`,
      `authorization=Basic ${knownSecret}`,
    ];

    for (const fixture of fixtures) {
      const once = redactSecrets(fixture, [knownSecret]);
      const twice = redactSecrets(once, [knownSecret]);
      expect(once).not.toContain(knownSecret);
      expect(twice).toBe(once);
      expect((once.match(/\[redacted\]/g) ?? []).length).toBe(1);
      expect(once).not.toContain(']]');
    }
  });

  test('keeps authorization placeholders stable through repeated feature sanitation', () => {
    const structured = {
      command: 'Authorization: Bearer [redacted]',
      instructions: [
        'Authorization=Bearer [redacted]',
        'authorization: Basic [redacted]',
        'authorization=Basic [redacted]',
      ],
    };
    const once = sanitizeFeatureResult(structured);
    const twice = sanitizeFeatureResult(once);
    expect(once).toEqual(structured);
    expect(twice).toEqual(once);
    expect(JSON.stringify(twice)).not.toContain(']]');
  });
});
