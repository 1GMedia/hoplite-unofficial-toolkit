import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HopliteAccessError,
  parseProjectAgentToolPayload,
  projectAgentDefaultCommandDefinitions,
  projectAgentsGet,
  projectAgentsPlanSet,
} from './project-agent-defaults';
import { run } from './index';

const PROJECT_ID = 'prj_fixture';
const SECRET_INSTRUCTIONS = 'Private fixture instruction: do not repeat this in the receipt.';

const project = {
  ok: true,
  project: {
    id: PROJECT_ID,
    name: 'Fixture project',
    defaultModel: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    agentSpeed: 'standard',
    prReviewAutofixDefault: false,
    instructions: 'Existing fixture instructions',
  },
};

const catalog = {
  models: [
    {
      id: 'gpt-5.6-sol',
      capabilities: {
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        supportsFast: true,
      },
    },
    {
      id: 'gpt-5.6-terra',
      capabilities: {
        reasoningLevels: ['none', 'low', 'medium', 'high'],
        supportsFast: false,
      },
    },
  ],
};

function fixtureCaller(projectPayload: Record<string, unknown> = project, catalogPayload: Record<string, unknown> = catalog) {
  const calls: Array<{ method: string; path: string }> = [];
  return {
    calls,
    call: async (method: 'GET', path: string) => {
      calls.push({ method, path });
      return path === '/api/model-providers' ? catalogPayload : projectPayload;
    },
  };
}

function planFrom(result: Record<string, unknown>): Record<string, unknown> {
  return result.plan as Record<string, unknown>;
}

describe('project agent defaults', () => {
  test('reads both exact routes and returns only a safe scalar projection', async () => {
    const fixture = fixtureCaller();
    const result = await projectAgentsGet(fixture.call, PROJECT_ID, new Map());
    expect(fixture.calls).toEqual([
      { method: 'GET', path: `/api/projects/${PROJECT_ID}` },
      { method: 'GET', path: '/api/model-providers' },
    ]);
    expect(result).toMatchObject({
      projectId: PROJECT_ID,
      defaultModel: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      agentSpeed: 'standard',
      instructionsConfigured: true,
      instructionsLength: 29,
      modelCatalogMatch: true,
    });
    expect(result).not.toHaveProperty('instructions');
  });

  test('bounds instructions behind an explicit include flag', async () => {
    const longProject = structuredClone(project);
    longProject.project.instructions = 'x'.repeat(5_000);
    const result = await projectAgentsGet(
      fixtureCaller(longProject).call,
      PROJECT_ID,
      new Map([['include-instructions', 'true']]),
    );
    expect((result.instructions as string).length).toBe(4_000);
    expect(result.instructionsTruncated).toBe(true);
    expect(result.instructionsLimit).toBe(4_000);
  });

  test('accepts the deployed runConfig model fallback shape without inventing capabilities', async () => {
    const solProject = {
      ...project,
      project: {
        ...project.project,
        defaultModel: 'gpt-5.6-sol',
        reasoningEffort: null,
        agentSpeed: null,
      },
    };
    const fallbackCatalog = {
      runConfig: { modelFallbackIds: ['gpt-5.6-sol', 'gpt-5.6-terra'] },
    };
    const result = await projectAgentsGet(
      fixtureCaller(solProject, fallbackCatalog).call,
      PROJECT_ID,
      new Map(),
    );
    expect(result).toMatchObject({
      defaultModel: 'gpt-5.6-sol',
      modelCatalogMatch: true,
      modelCapabilitiesEvidenced: false,
      modelCapabilities: null,
    });
    await expect(projectAgentsPlanSet(
      fixtureCaller(solProject, fallbackCatalog).call,
      PROJECT_ID,
      new Map([['reasoning', 'high']]),
    )).rejects.toThrow('capabilities are not evidenced');

    const optionalModelResult = await projectAgentsGet(
      fixtureCaller(solProject, {
        models: [{ id: 'gpt-5.6-sol' }],
        runConfig: { modelFallbackIds: ['gpt-5.6-sol'] },
      }).call,
      PROJECT_ID,
      new Map(),
    );
    expect(optionalModelResult).toMatchObject({
      modelCatalogMatch: true,
      modelCapabilitiesEvidenced: false,
    });
  });

  test('allows unrelated plans and safe capability reductions with fallback-only catalogs', async () => {
    const configuredProject = {
      ...project,
      project: {
        ...project.project,
        defaultModel: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        agentSpeed: 'fast',
        prReviewAutofixDefault: false,
      },
    };
    const fallbackCatalog = {
      runConfig: { modelFallbackIds: ['gpt-5.6-sol', 'gpt-5.6-terra'] },
    };
    const unrelated = await projectAgentsPlanSet(
      fixtureCaller(configuredProject, fallbackCatalog).call,
      PROJECT_ID,
      new Map([['pr-review-autofix', 'true']]),
    );
    expect(planFrom(unrelated).changes).toEqual({ prReviewAutofixDefault: true });

    const cleared = await projectAgentsPlanSet(
      fixtureCaller(configuredProject, fallbackCatalog).call,
      PROJECT_ID,
      new Map([
        ['reasoning', 'inherit'],
        ['speed', 'inherit'],
      ]),
    );
    expect(planFrom(cleared).changes).toEqual({
      reasoningEffort: null,
      agentSpeed: null,
    });

    const disabledFast = await projectAgentsPlanSet(
      fixtureCaller(configuredProject, fallbackCatalog).call,
      PROJECT_ID,
      new Map([['speed', 'standard']]),
    );
    expect(planFrom(disabledFast).changes).toEqual({ agentSpeed: 'standard' });

    const changedModelWithReductions = await projectAgentsPlanSet(
      fixtureCaller(configuredProject, fallbackCatalog).call,
      PROJECT_ID,
      new Map([
        ['model', 'gpt-5.6-terra'],
        ['reasoning', 'inherit'],
        ['speed', 'standard'],
      ]),
    );
    expect(planFrom(changedModelWithReductions).changes).toEqual({
      defaultModel: 'gpt-5.6-terra',
      reasoningEffort: null,
      agentSpeed: 'standard',
    });

    for (const [flag, value] of [
      ['reasoning', 'medium'],
      ['model', 'gpt-5.6-terra'],
    ] as const) {
      await expect(projectAgentsPlanSet(
        fixtureCaller(configuredProject, fallbackCatalog).call,
        PROJECT_ID,
        new Map([[flag, value]]),
      )).rejects.toThrow('capabilities are not evidenced');
    }

    const standardProject = {
      ...configuredProject,
      project: { ...configuredProject.project, reasoningEffort: null, agentSpeed: 'standard' },
    };
    await expect(projectAgentsPlanSet(
      fixtureCaller(standardProject, fallbackCatalog).call,
      PROJECT_ID,
      new Map([['speed', 'fast']]),
    )).rejects.toThrow('capabilities are not evidenced');
  });

  test('allows model inheritance only when reasoning and fast speed are also cleared', async () => {
    const configuredProject = {
      ...project,
      project: {
        ...project.project,
        defaultModel: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        agentSpeed: 'fast',
      },
    };
    const fallbackCatalog = {
      runConfig: { modelFallbackIds: ['gpt-5.6-sol'] },
    };
    await expect(projectAgentsPlanSet(
      fixtureCaller(configuredProject, fallbackCatalog).call,
      PROJECT_ID,
      new Map([['model', 'inherit']]),
    )).rejects.toThrow('concrete model');

    const cleared = await projectAgentsPlanSet(
      fixtureCaller(configuredProject, fallbackCatalog).call,
      PROJECT_ID,
      new Map([
        ['model', 'inherit'],
        ['reasoning', 'inherit'],
        ['speed', 'inherit'],
      ]),
    );
    expect(planFrom(cleared).changes).toEqual({
      defaultModel: null,
      reasoningEffort: null,
      agentSpeed: null,
    });
  });

  test('plans GPT-5.6 Sol with high reasoning and fast speed against the live fixture catalog', async () => {
    const result = await projectAgentsPlanSet(fixtureCaller().call, PROJECT_ID, new Map([
      ['model', 'gpt-5.6-sol'],
      ['reasoning', 'high'],
      ['speed', 'fast'],
      ['client-operation-id', 'fixture-sol-high-fast'],
    ]));
    const plan = planFrom(result);
    expect(plan.target).toEqual({
      projectId: PROJECT_ID,
      method: 'PATCH',
      path: `/api/projects/${PROJECT_ID}`,
    });
    expect(plan.changes).toEqual({
      defaultModel: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      agentSpeed: 'fast',
    });
    expect(plan.changedFields).toEqual(['defaultModel', 'reasoningEffort', 'agentSpeed']);
    expect(plan.beforeStateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((plan.contractIdentity as Record<string, unknown>).applySupported).toBe(false);
    expect(result.remoteStateChanged).toBe(false);
  });

  test('rejects unsupported reasoning and fast speed', async () => {
    await expect(projectAgentsPlanSet(fixtureCaller().call, PROJECT_ID, new Map([
      ['model', 'gpt-5.6-terra'],
      ['reasoning', 'xhigh'],
    ]))).rejects.toThrow('does not support reasoning effort xhigh');
    await expect(projectAgentsPlanSet(fixtureCaller().call, PROJECT_ID, new Map([
      ['model', 'gpt-5.6-terra'],
      ['speed', 'fast'],
    ]))).rejects.toThrow('does not support fast speed');
  });

  test('normalizes inherit and empty values to null', async () => {
    const solProject = structuredClone(project);
    solProject.project.defaultModel = 'gpt-5.6-sol';
    solProject.project.reasoningEffort = 'high';
    solProject.project.agentSpeed = 'fast';
    const result = await projectAgentsPlanSet(fixtureCaller(solProject).call, PROJECT_ID, new Map([
      ['model', 'inherit'],
      ['reasoning', ''],
      ['speed', 'inherit'],
    ]));
    expect(planFrom(result).changes).toEqual({
      defaultModel: null,
      reasoningEffort: null,
      agentSpeed: null,
    });
  });

  test('normalizes a blank explicit instructions file to null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoplite-project-agent-blank-'));
    const instructionsPath = join(dir, 'instructions.md');
    try {
      writeFileSync(instructionsPath, '  \n', { mode: 0o600 });
      const result = await projectAgentsPlanSet(fixtureCaller().call, PROJECT_ID, new Map([
        ['instructions-file', instructionsPath],
      ]));
      expect(planFrom(result).changes).toEqual({ instructions: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('omits unchanged values from the change set', async () => {
    const result = await projectAgentsPlanSet(fixtureCaller().call, PROJECT_ID, new Map([
      ['model', 'gpt-5.6-terra'],
      ['reasoning', 'medium'],
      ['speed', 'standard'],
      ['pr-review-autofix', 'false'],
    ]));
    const plan = planFrom(result);
    expect(plan.changes).toEqual({});
    expect(plan.changedFields).toEqual([]);
  });

  test('writes instruction text only to a new owner-only plan and never repeats it in the receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoplite-project-agent-secret-'));
    const instructionsPath = join(dir, 'instructions.md');
    const planPath = join(dir, 'plan.json');
    try {
      writeFileSync(instructionsPath, SECRET_INSTRUCTIONS, { mode: 0o600 });
      const result = await projectAgentsPlanSet(fixtureCaller().call, PROJECT_ID, new Map([
        ['instructions-file', instructionsPath],
        ['out', planPath],
        ['client-operation-id', 'fixture-private-instructions'],
      ]));
      expect(statSync(planPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(planPath, 'utf8')).toContain(SECRET_INSTRUCTIONS);
      expect(JSON.stringify(result)).not.toContain(SECRET_INSTRUCTIONS);
      expect(result).not.toHaveProperty('plan');
      expect(result).toMatchObject({
        remoteStateChanged: false,
        applySupported: false,
        changedFields: ['instructions'],
        instructionsIncludedInPlanFile: true,
      });
      expect(() => writeFileSync(planPath, 'replacement', { flag: 'wx' })).toThrow();
    } finally {
      chmodSync(planPath, 0o600);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects symlink and FIFO instruction inputs without following or blocking', async () => {
    if (process.platform === 'win32') return;
    const dir = mkdtempSync(join(tmpdir(), 'hoplite-project-agent-input-type-'));
    const instructionsPath = join(dir, 'instructions.md');
    const symlinkPath = join(dir, 'instructions-link.md');
    const fifoPath = join(dir, 'instructions.fifo');
    try {
      writeFileSync(instructionsPath, SECRET_INSTRUCTIONS, { mode: 0o600 });
      symlinkSync(instructionsPath, symlinkPath);
      await expect(projectAgentsPlanSet(fixtureCaller().call, PROJECT_ID, new Map([
        ['instructions-file', symlinkPath],
      ]))).rejects.toThrow();

      const created = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
      if (created.error && (created.error as NodeJS.ErrnoException).code === 'ENOENT') return;
      expect(created.status).toBe(0);
      const started = performance.now();
      await expect(projectAgentsPlanSet(fixtureCaller().call, PROJECT_ID, new Map([
        ['instructions-file', fifoPath],
      ]))).rejects.toThrow('regular non-symlink');
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects unknown flags and extra positionals before any MCP network read', async () => {
    let calls = 0;
    const fakeClient = {
      callTool: async () => {
        calls += 1;
        throw new Error('network should not be called');
      },
    };
    const get = projectAgentDefaultCommandDefinitions.find(command => command.name === 'project-agents-get');
    const plan = projectAgentDefaultCommandDefinitions.find(command => command.name === 'project-agents-plan-set');
    if (!get || get.transport !== 'mcp' || !plan || plan.transport !== 'mcp') throw new Error('fixture commands missing');
    await expect(get.run({
      client: fakeClient as never,
      positionals: [PROJECT_ID],
      flags: new Map([['out', 'unexpected.json']]),
    })).rejects.toThrow('Unknown flag');
    await expect(plan.run({
      client: fakeClient as never,
      positionals: [PROJECT_ID, 'extra'],
      flags: new Map([['model', 'gpt-5.6-sol']]),
    })).rejects.toThrow('exactly one');
    await expect(plan.run({
      client: fakeClient as never,
      positionals: [PROJECT_ID],
      flags: new Map([['include-instructions', 'true']]),
    })).rejects.toThrow('Unknown flag');
    expect(calls).toBe(0);
  });

  test('runs registry validation before opening an MCP session', async () => {
    const priorPath = process.env.HOPLITE_OAUTH_PATH;
    process.env.HOPLITE_OAUTH_PATH = join(tmpdir(), 'fixture-must-not-be-read-oauth.json');
    try {
      await expect(run([
        'project-agents-get',
        PROJECT_ID,
        '--out',
        'unexpected.json',
      ])).rejects.toThrow('Unknown flag');
      await expect(run([
        'project-agents-plan-set',
        PROJECT_ID,
        'extra',
        '--model',
        'gpt-5.6-sol',
      ])).rejects.toThrow('exactly one');
    } finally {
      if (priorPath === undefined) delete process.env.HOPLITE_OAUTH_PATH;
      else process.env.HOPLITE_OAUTH_PATH = priorPath;
    }
  });

  test('rejects project and catalog schema drift', async () => {
    await expect(projectAgentsGet(
      fixtureCaller({ project: { id: PROJECT_ID, defaultModel: 42 } }).call,
      PROJECT_ID,
      new Map(),
    )).rejects.toThrow('schema drift');
    await expect(projectAgentsGet(
      fixtureCaller(project, { models: [{ id: 'gpt-5.6-sol', capabilities: { supportsFast: true } }] }).call,
      PROJECT_ID,
      new Map(),
    )).rejects.toThrow('reasoningLevels');
  });

  test('distinguishes authentication failures from authorization failures', () => {
    const response = (status: number) => ({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ status, error: 'fixture' }) }],
    });
    for (const status of [401, 403] as const) {
      try {
        parseProjectAgentToolPayload(response(status));
        throw new Error('expected access error');
      } catch (error) {
        expect(error).toBeInstanceOf(HopliteAccessError);
        expect((error as HopliteAccessError).status).toBe(status);
      }
    }
  });
});
