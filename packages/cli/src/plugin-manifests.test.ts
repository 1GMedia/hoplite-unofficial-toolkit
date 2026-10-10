import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const endpoint = 'https://api.hoplite.sh/mcp';

function json(path: string) {
  return JSON.parse(readFileSync(new URL(path, root), 'utf8'));
}

function component(path: string) {
  expect(path.startsWith('./')).toBe(true);
  expect(path.split('/')).not.toContain('..');
  const url = new URL(path, root);
  expect(statSync(url)).toBeDefined();
  return url;
}

describe('offline plugin manifests', () => {
  test('Codex local marketplace resolves to this plugin root', () => {
    const marketplace = json('.agents/plugins/marketplace.json');
    expect(marketplace.name).toBe('hoplite-toolkit-local');
    expect(marketplace.plugins).toHaveLength(1);
    const plugin = marketplace.plugins[0];
    expect(plugin.name).toBe(json('.codex-plugin/plugin.json').name);
    expect(plugin.source).toEqual({ source: 'local', path: './' });
    expect(component(plugin.source.path).href).toBe(root.href);
    expect(plugin.policy).toEqual({ installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
    expect(plugin.category).toBe('Productivity');
  });

  for (const client of ['claude', 'cursor', 'codex']) {
    test(`${client} bundles both skills and env-only hosted MCP configuration`, () => {
      const manifest = json(`.${client}-plugin/plugin.json`);
      expect(manifest.name).toBe('hoplite-toolkit');
      expect(manifest.version).toBe(json('package.json').version);
      expect(manifest.description).toContain('Unofficial');
      expect(manifest.skills).toBe('./skills/');
      const skills = component(manifest.skills);
      expect(statSync(skills).isDirectory()).toBe(true);
      expect(readdirSync(skills).sort()).toEqual(['hoplite-cli', 'hoplite-env-import']);
      for (const name of readdirSync(skills)) {
        const skill = readFileSync(new URL(`${name}/SKILL.md`, skills), 'utf8');
        expect(skill).toStartWith(`---\nname: ${name}\ndescription: `);
      }

      let servers = manifest.mcpServers;
      if (client === 'cursor') {
        expect(statSync(component(servers)).isFile()).toBe(true);
        servers = json(servers).mcpServers;
      }
      expect(Object.keys(servers)).toEqual(['hoplite']);
      expect(servers.hoplite).toEqual(client === 'codex'
        ? { type: 'http', url: endpoint, bearer_token_env_var: 'HOPLITE_API_KEY' }
        : {
          ...(client === 'claude' ? { type: 'http' } : {}),
          url: endpoint,
          headers: { Authorization: client === 'claude'
            ? 'Bearer ${HOPLITE_API_KEY}' : 'Bearer ${env:HOPLITE_API_KEY}' },
        });
      expect(manifest.hooks).toBeUndefined();
    });
  }
});
