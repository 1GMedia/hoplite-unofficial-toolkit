import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const skillRoot = new URL('skills/hoplite-factory/', root);
const source = 'https://hoplite.sh/docs/factory-example.mjs';

function frontmatter() {
  const skill = readFileSync(new URL('SKILL.md', skillRoot), 'utf8');
  const match = /^---\n([\s\S]+?)\n---\n/.exec(skill);
  expect(match).not.toBeNull();
  return Bun.YAML.parse(match![1]!) as {
    name: string;
    description: string;
    metadata: Record<string, string>;
  };
}

describe('Factory skill (offline artifact validation)', () => {
  test('frontmatter parses and records the upstream provenance', () => {
    const data = frontmatter();
    expect(data.name).toBe('hoplite-factory');
    expect(typeof data.description).toBe('string');
    expect(data.description.length).toBeGreaterThan(0);
    expect(data.metadata['upstream-source']).toBe(source);
    expect(data.metadata['upstream-sha256']).toMatch(/^[a-f0-9]{64}$/);
    expect(data.metadata['upstream-runner']).toBe('scripts/factory-example.mjs');
  });

  test('runner bytes match the skill pin without executing it', () => {
    const { metadata } = frontmatter();
    const runner = readFileSync(new URL(metadata['upstream-runner']!, skillRoot));
    const sha256 = createHash('sha256').update(runner).digest('hex');
    expect(sha256).toBe(metadata['upstream-sha256']);
  });
});
