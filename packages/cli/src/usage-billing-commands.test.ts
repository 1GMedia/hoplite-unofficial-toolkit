import { describe, expect, test } from 'bun:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { compatibilitySnapshot } from './compatibility';
import type { CommandResult, McpCommandDefinition } from './command-registry';
import { run } from './index';
import { buildUsageRange, usageBillingCommandDefinitions } from './usage-billing-commands';

type ToolRequest = { name: string; arguments?: Record<string, unknown> };
type ToolResponder = (request: ToolRequest, options: unknown) => unknown | Promise<unknown>;

function toolJson(payload: unknown, isError = false): unknown {
  return { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function apiResource(key: string, value: unknown): unknown {
  return toolJson({ ok: true, status: 200, body: { ok: true, [key]: value } });
}

function apiStatus(status: number): unknown {
  return toolJson({ ok: false, status, body: {} });
}

async function execute(
  name: string,
  responder: ToolResponder,
  positionals: string[] = [],
  flags = new Map<string, string>(),
): Promise<{ result: CommandResult; calls: Array<{ request: ToolRequest; options: unknown }> }> {
  const calls: Array<{ request: ToolRequest; options: unknown }> = [];
  const client = {
    callTool: async (request: ToolRequest, _schema: unknown, options: unknown) => {
      calls.push({ request, options });
      return responder(request, options);
    },
  } as unknown as Client;
  const command = usageBillingCommandDefinitions.find(candidate => candidate.name === name);
  if (!command || command.transport !== 'mcp') throw new Error(`Missing MCP command ${name}`);
  const result = await (command as McpCommandDefinition).run({ client, positionals, flags });
  return { result, calls };
}

function subscriptionFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configured: true,
    hasBillingHistory: true,
    subscriptionId: 'sub_fixture_private',
    plan: 'pro',
    billingInterval: 'annual',
    status: 'active',
    entitlementActive: true,
    entitlementSource: 'stripe',
    trialExpiresAt: null,
    paidSeatQuantity: 3,
    currentPeriodStart: '2026-08-01T00:00:00.000Z',
    currentPeriodEnd: '2026-09-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    graceEndsAt: null,
    paymentActionUrl: null,
    pendingChange: null,
    latestInvoice: null,
    ...overrides,
  };
}

function invoiceFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'invoice_fixture_private',
    status: 'open',
    amountDue: 987_654,
    amountPaid: 123_456,
    billingReason: 'subscription_cycle',
    currency: 'usd',
    hostedInvoiceUrl: 'https://invoices.example/private-hosted',
    invoicePdf: 'https://invoices.example/private.pdf',
    nextPaymentAttempt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('usage and billing read commands', () => {
  test('builds only fixed 7, 30, or 90 day usage windows', () => {
    const now = new Date('2026-08-26T12:00:00.000Z');
    expect(buildUsageRange(undefined, now)).toEqual({
      days: 30,
      from: '2026-07-27T12:00:00.000Z',
      to: '2026-08-26T12:00:00.000Z',
    });
    expect(buildUsageRange('7', now).days).toBe(7);
    expect(buildUsageRange('30', now).days).toBe(30);
    expect(buildUsageRange('90', now).days).toBe(90);
    for (const value of [
      '0', '1', '29', '30.5', '365', 'latest',
      '07', '7.0', '7e0', '+7', ' 7', '7 ', '030', '30.0', '90.0',
    ]) {
      expect(() => buildUsageRange(value, now)).toThrow('--days');
    }
  });

  test('reads aggregate usage totals with one GET and no provider or row details', async () => {
    const { result, calls } = await execute(
      'usage-summary-get',
      () => apiResource('totals', {
        costMicros: 125_000,
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 25,
        reasoningTokens: 10,
        events: 4,
      }),
      [],
      new Map([['days', '7']]),
    );
    expect(result.ok).toBe(true);
    expect(result.range).toEqual({ days: 7 });
    expect(result.totals).toEqual({
      costMicros: 125_000,
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 25,
      reasoningTokens: 10,
      events: 4,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.arguments).toEqual({
      method: 'GET',
      path: '/api/usage/totals',
      query: {
        from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    });
    expect(calls[0]?.options).toEqual({ timeout: 20_000, maxTotalTimeout: 20_000 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/provider|model|userId|threadId|runId/);
    const query = calls[0]?.request.arguments?.query as Record<string, string>;
    expect(serialized).not.toContain(query.from);
    expect(serialized).not.toContain(query.to);
    expect(serialized).not.toMatch(/"(?:from|to)":/);
  });

  test('summarizes bounded budgets without policy or subject identifiers', async () => {
    const { result, calls } = await execute('billing-budgets-summary', () => apiResource('budgets', {
      policies: [
        {
          id: 'policy_private_workspace',
          scope: 'workspace',
          subjectId: 'workspace_private',
          period: 'monthly',
          limitCredits: 100,
          alertThresholdCredits: [50, 80],
          enabled: true,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
        },
        {
          id: 'policy_private_project',
          scope: 'project',
          subjectId: 'project_private',
          period: 'monthly',
          limitCredits: 25,
          alertThresholdCredits: [],
          enabled: false,
          createdAt: '2026-08-03T00:00:00.000Z',
          updatedAt: '2026-08-04T00:00:00.000Z',
        },
      ],
    }));
    expect(result).toEqual({
      ok: true,
      path: '/api/billing/budgets',
      status: 200,
      policyCount: 2,
      enabledCount: 1,
      disabledCount: 1,
      scopeCounts: { workspace: 1, project: 1, user: 0, automation: 0 },
      totalMonthlyLimitCredits: 125,
      alertThresholdCount: 2,
    });
    expect(calls[0]?.request.arguments).toEqual({ method: 'GET', path: '/api/billing/budgets' });
    expect(JSON.stringify(result)).not.toMatch(/private|subjectId|policy_/);
  });

  test('summarizes at most ten grants without sources, descriptions, IDs, or timestamps', async () => {
    const { result, calls } = await execute('billing-grants-summary', () => apiResource('grants', {
      grants: [
        {
          id: 'grant_private_one',
          createdAt: '2026-08-01T00:00:00.000Z',
          source: 'stripe_top_up',
          description: 'private grant note',
          amountCredits: 20,
        },
        {
          id: 'grant_private_two',
          createdAt: '2026-08-02T00:00:00.000Z',
          source: 'starter',
          description: null,
          amountCredits: 5,
        },
      ],
    }));
    expect(result).toEqual({
      ok: true,
      path: '/api/billing/grants',
      status: 200,
      limit: 10,
      grantCount: 2,
      totalAmountCredits: 25,
    });
    expect(calls[0]?.request.arguments).toEqual({
      method: 'GET',
      path: '/api/billing/grants',
      query: { limit: 10 },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|stripe|starter|createdAt/);
  });

  test('projects safe credit aggregates without customer or feature identifiers', async () => {
    const { result, calls } = await execute('billing-summary-get', () => apiResource('billing', {
      customerId: 'customer_fixture_private',
      featureId: 'feature_fixture_private',
      grantedCredits: 100,
      remainingCredits: 65,
      usedCredits: 30,
      heldCredits: 5,
      available: true,
      nextResetAt: '2026-09-01T00:00:00.000Z',
    }));
    expect(result).toEqual({
      ok: true,
      path: '/api/billing/summary',
      status: 200,
      available: true,
      credits: { granted: 100, remaining: 65, used: 30, held: 5 },
    });
    expect(calls[0]?.request.arguments).toEqual({ method: 'GET', path: '/api/billing/summary' });
    expect(JSON.stringify(result)).not.toMatch(/customer_fixture|feature_fixture|customerId|featureId|nextResetAt|2026-09-01/);
  });

  test('reads only bounded plan status fields', async () => {
    const { result, calls } = await execute('billing-plan-get', () => apiResource('plan', {
      plan: 'scale',
      billingInterval: 'monthly',
      sandboxIdleMinutes: 30,
      seatCount: 4,
    }));
    expect(result).toEqual({
      ok: true,
      path: '/api/billing/plan',
      status: 200,
      plan: {
        name: 'scale',
        billingInterval: 'monthly',
        sandboxIdleMinutes: 30,
        seatCount: 4,
      },
    });
    expect(calls[0]?.request.arguments).toEqual({ method: 'GET', path: '/api/billing/plan' });
  });

  test('maps unrecognized subscription statuses to unknown and omits all IDs, amounts, and URLs', async () => {
    const { result, calls } = await execute('billing-subscription-status', () => apiResource(
      'subscription',
      subscriptionFixture({
        status: 'Authorization: Bearer fixture_subscription_secret',
        paymentActionUrl: 'https://payments.example/private-action',
        pendingChange: {
          plan: 'scale',
          billingInterval: 'monthly',
          paidSeatQuantity: 5,
          effectiveAt: '2026-09-01T00:00:00.000Z',
        },
        latestInvoice: invoiceFixture(),
      }),
    ));
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'fixture_subscription_secret',
      'sub_fixture_private',
      'invoice_fixture_private',
      'stripe',
      'payments.example',
      'invoices.example',
      '987654',
      '123456',
      'subscription_cycle',
    ]) expect(serialized).not.toContain(forbidden);
    expect(serialized).not.toMatch(/subscriptionId|invoicePdf|hostedInvoiceUrl|amountDue|amountPaid/);
    expect(serialized).not.toMatch(/trialExpiresAt|currentPeriodStart|currentPeriodEnd|graceEndsAt|effectiveAt|nextPaymentAttempt/);
    expect(serialized).not.toMatch(/2026-08-01|2026-08-28|2026-09-01/);
    const projected = result.subscription as Record<string, unknown>;
    expect(projected.status).toBe('unknown');
    expect(projected.paymentActionRequired).toBe(true);
    expect(projected.latestInvoicePresent).toBe(true);
    expect(projected.latestInvoiceStatus).toBe('open');
    expect(calls[0]?.request.arguments).toEqual({ method: 'GET', path: '/api/billing/subscription' });
  });

  test('emits only evidenced status values or unknown through the full subscription handler', async () => {
    const secretLikeSubscriptionStatus = ['sk', 'proj', 'fixture', 'subscription'].join('-');
    const secretLikeInvoiceStatus = ['github', 'pat', 'fixture', 'invoice'].join('_');
    const providerSubscriptionId = ['sub', 'provider', 'fixture-private'].join('_');
    const providerInvoiceId = ['in', 'provider', 'fixture-private'].join('_');
    const cases = [
      { subscriptionStatus: 'active', invoiceStatus: 'open', expectedSubscription: 'active', expectedInvoice: 'open' },
      { subscriptionStatus: 'past_due', invoiceStatus: 'paid', expectedSubscription: 'unknown', expectedInvoice: 'unknown' },
      {
        subscriptionStatus: secretLikeSubscriptionStatus,
        invoiceStatus: secretLikeInvoiceStatus,
        expectedSubscription: 'unknown',
        expectedInvoice: 'unknown',
      },
    ];
    for (const testCase of cases) {
      const { result } = await execute('billing-subscription-status', () => apiResource(
        'subscription',
        subscriptionFixture({
          subscriptionId: providerSubscriptionId,
          status: testCase.subscriptionStatus,
          latestInvoice: invoiceFixture({ id: providerInvoiceId, status: testCase.invoiceStatus }),
        }),
      ));
      expect(result.ok).toBe(true);
      const projected = result.subscription as Record<string, unknown>;
      expect(projected.status).toBe(testCase.expectedSubscription);
      expect(projected.latestInvoiceStatus).toBe(testCase.expectedInvoice);
      const serialized = JSON.stringify(result);
      for (const forbidden of [
        secretLikeSubscriptionStatus,
        secretLikeInvoiceStatus,
        providerSubscriptionId,
        providerInvoiceId,
      ]) expect(serialized).not.toContain(forbidden);
      if (testCase.expectedSubscription === 'unknown') {
        expect(serialized).not.toContain(JSON.stringify(testCase.subscriptionStatus));
      }
      if (testCase.expectedInvoice === 'unknown') {
        expect(serialized).not.toContain(JSON.stringify(testCase.invoiceStatus));
      }
    }
  });

  test('fails closed on row ceilings, shape drift, enums, and unsafe numeric aggregates', async () => {
    const tooManyGrants = Array.from({ length: 11 }, (_, index) => ({
      id: `grant_fixture_${index}`,
      createdAt: '2026-08-01T00:00:00.000Z',
      source: 'fixture',
      description: null,
      amountCredits: 1,
    }));
    const tooManyPolicies = Array.from({ length: 101 }, (_, index) => ({
      id: `policy_fixture_${index}`,
      scope: 'project',
      subjectId: `project_fixture_${index}`,
      period: 'monthly',
      limitCredits: 1,
      alertThresholdCredits: [],
      enabled: true,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }));
    const driftCases: Array<[string, unknown]> = [
      ['billing-grants-summary', apiResource('grants', { grants: tooManyGrants })],
      ['billing-budgets-summary', apiResource('budgets', { policies: tooManyPolicies })],
      ['billing-plan-get', apiResource('plan', { plan: 'enterprise', billingInterval: 'monthly', sandboxIdleMinutes: 30, seatCount: 1 })],
      ['billing-summary-get', apiResource('billing', { customerId: 'c', featureId: 'f', available: true, unexpected: true })],
      ['billing-summary-get', apiResource('billing', { customerId: 'x'.repeat(4_097), featureId: 'f', available: true })],
      ['usage-summary-get', apiResource('totals', { costMicros: Number.MAX_SAFE_INTEGER, inputTokens: Number.MAX_SAFE_INTEGER + 1 })],
      ['billing-subscription-status', apiResource('subscription', subscriptionFixture({ unexpected: true }))],
      ['billing-subscription-status', apiResource('subscription', subscriptionFixture({
        latestInvoice: invoiceFixture({ amountDue: 1.5 }),
      }))],
      ['billing-subscription-status', apiResource('subscription', subscriptionFixture({
        latestInvoice: invoiceFixture({ amountPaid: 2.25 }),
      }))],
    ];
    for (const [command, response] of driftCases) {
      const { result } = await execute(command, () => response);
      expect(result).toEqual({
        ok: false,
        path: expect.stringMatching(/^\/api\//),
        status: 200,
        outcome: 'schema_drift',
      });
    }
  });

  test('rejects unsafe MCP envelopes and oversized text before parsing', async () => {
    const inheritedIsError = Object.assign(
      Object.create({ isError: false }) as Record<string, unknown>,
      { content: [{ type: 'text', text: '{}' }] },
    );
    const invalidResults = [
      { content: [{ type: 'text', text: '{}' }] },
      inheritedIsError,
      { content: [{ type: 'text', text: '{}' }], isError: false, extra: true },
      { content: [{ type: 'text', text: '{}' }], isError: true },
      { content: [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }], isError: false },
      { content: [{ type: 'image', text: '{}' }], isError: false },
      { content: [{ type: 'text' }], isError: false },
      { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 200, body: {}, extra: true }) }], isError: false },
      { content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024 + 1) }], isError: false },
    ];
    for (const response of invalidResults) {
      const { result } = await execute('billing-summary-get', () => response);
      expect(result).toEqual({
        ok: false,
        path: '/api/billing/summary',
        status: null,
        outcome: 'request_failed',
      });
    }
  });

  test('distinguishes auth and deployment outcomes and never retries transport errors', async () => {
    for (const [status, outcome] of [
      [401, 'unsupported_credential'],
      [402, 'subscription_required'],
      [403, 'role_denied'],
      [404, 'absent_or_unavailable'],
      [405, 'request_failed'],
      [429, 'request_failed'],
      [501, 'deployment_unavailable'],
      [500, 'request_failed'],
    ] as const) {
      const { result, calls } = await execute('billing-plan-get', () => apiStatus(status));
      expect(result).toEqual({ ok: false, path: '/api/billing/plan', status, outcome });
      expect(calls).toHaveLength(1);
    }
    let attempts = 0;
    const { result } = await execute('billing-plan-get', () => {
      attempts += 1;
      throw new Error('fixture transport failure');
    });
    expect(attempts).toBe(1);
    expect(result).toEqual({
      ok: false,
      path: '/api/billing/plan',
      status: null,
      outcome: 'request_failed',
    });
  });

  test('rejects unexpected positionals and flags before making a request', async () => {
    for (const [command, positionals, flags] of [
      ['billing-plan-get', ['unexpected'], new Map<string, string>()],
      ['billing-summary-get', [], new Map([['details', 'true']])],
      ['usage-summary-get', [], new Map([['from', '2026-01-01']])],
    ] as const) {
      let calls = 0;
      await expect(execute(command, () => {
        calls += 1;
        return apiStatus(500);
      }, [...positionals], new Map(flags))).rejects.toThrow();
      expect(calls).toBe(0);
    }
  });

  test('registers all commands and capability metadata while writes remain blocked', async () => {
    const help = await run(['help']);
    const commands = help.commands as Record<string, string>;
    for (const command of usageBillingCommandDefinitions) expect(commands[command.name]).toBe(command.description);

    const billing = compatibilitySnapshot(new Date('2026-08-26T00:00:00.000Z'), 'billing');
    const implemented = billing.capabilities.filter(entry => entry.status === 'implemented');
    expect(implemented.map(entry => entry.id).sort()).toEqual([
      'billing.budgets.summary',
      'billing.grants.summary',
      'billing.plan.get',
      'billing.subscription.get',
      'billing.summary.get',
      'usage.totals.get',
    ]);
    expect(implemented.every(entry => entry.method === 'GET' && entry.risk === 'R0')).toBe(true);
    for (const id of [
      'billing.budgets.update',
      'billing.plan.update',
      'billing.subscription.checkout',
      'billing.subscription.trial',
      'billing.subscription.preview',
      'billing.subscription.hosted-confirmation',
      'billing.subscription.cancel',
      'billing.subscription.reactivate',
      'billing.top-up.create',
      'billing.portal.open',
    ]) {
      const capability = billing.capabilities.find(entry => entry.id === id);
      expect(capability?.status).toBe('blocked');
      expect(capability?.risk).toBe('W3');
    }
    expect(usageBillingCommandDefinitions.some(command => command.name.includes('checkout'))).toBe(false);
    expect(usageBillingCommandDefinitions.some(command => command.name.includes('portal'))).toBe(false);
    expect(usageBillingCommandDefinitions.some(command => command.name.includes('cancel'))).toBe(false);
  });
});
