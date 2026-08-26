import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type {
  CliCommandDefinition,
  CommandResult,
  LocalCommandContext,
  McpCommandContext,
} from './command-registry';

type JsonObject = Record<string, unknown>;

type ApiOutcome =
  | 'unsupported_credential'
  | 'subscription_required'
  | 'role_denied'
  | 'absent_or_unavailable'
  | 'deployment_unavailable'
  | 'request_failed'
  | 'schema_drift';

type ApiReadResult =
  | { ok: true; status: 200; body: JsonObject }
  | { ok: false; status: number | null; outcome: ApiOutcome };

export type UsageRange = {
  days: 7 | 30 | 90;
  from: string;
  to: string;
};

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_TOOL_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_STRING_LENGTH = 4_096;
const MAX_BUDGET_POLICIES = 100;
const BILLING_GRANT_LIMIT = 10;
const SUBSCRIPTION_STATUS_ALLOWLIST = new Set(['active']);
const INVOICE_STATUS_ALLOWLIST = new Set(['open']);

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some(key => !allowedSet.has(key))) {
    throw new Error(`${label} contains unexpected fields`);
  }
}

function requirePresent(value: JsonObject, key: string, label: string): unknown {
  if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing ${key}`);
  return value[key];
}

function boundedString(value: unknown, label: string, max = MAX_INPUT_STRING_LENGTH): string {
  if (typeof value !== 'string' || value.length > max) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function nullableBoundedString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return boundedString(value, label);
}

function projectAllowlistedStatus(
  value: unknown,
  label: string,
  allowlist: ReadonlySet<string>,
): string | null {
  if (value === null) return null;
  const status = boundedString(value, label);
  return allowlist.has(status) ? status : 'unknown';
}

function finiteNumber(value: unknown, label: string, defaultValue?: number): number {
  const resolved = value === undefined && defaultValue !== undefined ? defaultValue : value;
  if (
    typeof resolved !== 'number'
    || !Number.isFinite(resolved)
    || Math.abs(resolved) > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(`${label} must be a bounded finite number`);
  }
  return resolved;
}

function integer(value: unknown, label: string, minimum: number): number {
  const resolved = finiteNumber(value, label);
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}`);
  }
  return resolved;
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  return integer(value, label, 1);
}

function checkedSum(values: readonly number[], label: string): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || Math.abs(total) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} exceeds the safe aggregate range`);
  }
  return total;
}

function validateUrl(value: unknown, label: string): void {
  const raw = boundedString(value, label, 2_048);
  try {
    new URL(raw);
  } catch {
    throw new Error(`${label} must be a URL`);
  }
}

function validateInvocation(context: LocalCommandContext, allowedFlags: readonly string[] = []): void {
  if (context.positionals.length > 0) throw new Error('This command does not accept positional arguments');
  const allowed = new Set(allowedFlags);
  const unexpected = [...context.flags.keys()].filter(flag => !allowed.has(flag));
  if (unexpected.length > 0) throw new Error(`Unsupported flag: --${unexpected[0]}`);
}

function outcomeForStatus(status: number | null): ApiOutcome {
  return {
    401: 'unsupported_credential',
    402: 'subscription_required',
    403: 'role_denied',
    404: 'absent_or_unavailable',
    501: 'deployment_unavailable',
  }[String(status)] as ApiOutcome | undefined ?? 'request_failed';
}

function parseToolPayload(result: unknown): JsonObject | null {
  if (!isRecord(result)) return null;
  try {
    requireExactKeys(result, ['content', 'isError'], 'MCP result');
  } catch {
    return null;
  }
  if (
    !Object.hasOwn(result, 'content')
    || !Object.hasOwn(result, 'isError')
    || Object.keys(result).length !== 2
    || result.isError !== false
    || !Array.isArray(result.content)
    || result.content.length !== 1
  ) return null;
  const block = result.content[0];
  if (!isRecord(block)) return null;
  try {
    requireExactKeys(block, ['type', 'text'], 'MCP text content');
  } catch {
    return null;
  }
  if (
    !Object.hasOwn(block, 'type')
    || !Object.hasOwn(block, 'text')
    || block.type !== 'text'
    || typeof block.text !== 'string'
  ) return null;
  const text = block.text as string;
  if (new TextEncoder().encode(text).byteLength > MAX_TOOL_RESPONSE_BYTES) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return null;
    requireExactKeys(parsed, ['ok', 'status', 'body'], 'API result');
    if (
      !Object.hasOwn(parsed, 'ok')
      || !Object.hasOwn(parsed, 'status')
      || !Object.hasOwn(parsed, 'body')
      || typeof parsed.ok !== 'boolean'
      || !Number.isInteger(parsed.status)
      || (parsed.status as number) < 100
      || (parsed.status as number) > 599
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readApi(
  client: Client,
  path: string,
  query?: Record<string, string | number>,
): Promise<ApiReadResult> {
  let result: unknown;
  try {
    result = await client.callTool(
      {
        name: 'hoplite_call_api',
        arguments: { method: 'GET', path, ...(query ? { query } : {}) },
      },
      undefined,
      { timeout: REQUEST_TIMEOUT_MS, maxTotalTimeout: REQUEST_TIMEOUT_MS },
    );
  } catch {
    return { ok: false, status: null, outcome: 'request_failed' };
  }

  const payload = parseToolPayload(result);
  if (!payload) return { ok: false, status: null, outcome: 'request_failed' };
  const status = Number.isInteger(payload.status) ? payload.status as number : null;
  if (status === 200) {
    if (payload.ok !== true || !isRecord(payload.body)) {
      return { ok: false, status, outcome: 'schema_drift' };
    }
    return { ok: true, status, body: payload.body };
  }
  if (payload.ok !== false) return { ok: false, status, outcome: 'request_failed' };
  return { ok: false, status, outcome: outcomeForStatus(status) };
}

function schemaDrift(path: string): CommandResult {
  return { ok: false, path, status: 200, outcome: 'schema_drift' };
}

function projectFailure(path: string, result: Exclude<ApiReadResult, { ok: true }>): CommandResult {
  return { ok: false, path, status: result.status, outcome: result.outcome };
}

function bodyResource(body: JsonObject, key: string, label: string): JsonObject {
  requireExactKeys(body, ['ok', key], `${label} response`);
  if (requirePresent(body, 'ok', `${label} response`) !== true) throw new Error(`${label} response is not ok`);
  const resource = requirePresent(body, key, `${label} response`);
  if (!isRecord(resource)) throw new Error(`${label} must be an object`);
  return resource;
}

export function buildUsageRange(rawDays: string | undefined, now = new Date()): UsageRange {
  const days = rawDays === undefined || rawDays === '30'
    ? 30
    : rawDays === '7'
      ? 7
      : rawDays === '90'
        ? 90
        : null;
  if (days === null) {
    throw new Error('--days must be exactly 7, 30, or 90');
  }
  const toMs = now.getTime();
  if (!Number.isFinite(toMs)) throw new Error('Usage range clock is invalid');
  return {
    days,
    from: new Date(toMs - days * 86_400_000).toISOString(),
    to: new Date(toMs).toISOString(),
  };
}

function validateUsageInvocation(context: LocalCommandContext): void {
  validateInvocation(context, ['days']);
  buildUsageRange(context.flags.get('days'));
}

async function usageSummaryGet(context: McpCommandContext): Promise<CommandResult> {
  validateUsageInvocation(context);
  const path = '/api/usage/totals';
  const range = buildUsageRange(context.flags.get('days'));
  const result = await readApi(context.client, path, { from: range.from, to: range.to });
  if (!result.ok) return projectFailure(path, result);
  try {
    const totals = bodyResource(result.body, 'totals', 'Usage totals');
    requireExactKeys(totals, [
      'costMicros',
      'inputTokens',
      'outputTokens',
      'cachedInputTokens',
      'reasoningTokens',
      'events',
    ], 'Usage totals');
    return {
      ok: true,
      path,
      status: 200,
      range: { days: range.days },
      totals: {
        costMicros: finiteNumber(totals.costMicros, 'Usage costMicros', 0),
        inputTokens: finiteNumber(totals.inputTokens, 'Usage inputTokens', 0),
        outputTokens: finiteNumber(totals.outputTokens, 'Usage outputTokens', 0),
        cachedInputTokens: finiteNumber(totals.cachedInputTokens, 'Usage cachedInputTokens', 0),
        reasoningTokens: finiteNumber(totals.reasoningTokens, 'Usage reasoningTokens', 0),
        events: finiteNumber(totals.events, 'Usage events', 0),
      },
    };
  } catch {
    return schemaDrift(path);
  }
}

async function billingBudgetsSummary(context: McpCommandContext): Promise<CommandResult> {
  validateInvocation(context);
  const path = '/api/billing/budgets';
  const result = await readApi(context.client, path);
  if (!result.ok) return projectFailure(path, result);
  try {
    const budgets = bodyResource(result.body, 'budgets', 'Billing budgets');
    requireExactKeys(budgets, ['policies'], 'Billing budgets');
    const policies = requirePresent(budgets, 'policies', 'Billing budgets');
    if (!Array.isArray(policies) || policies.length > MAX_BUDGET_POLICIES) {
      throw new Error('Billing policies exceed the row ceiling');
    }
    const scopes = ['workspace', 'project', 'user', 'automation'] as const;
    const scopeCounts = Object.fromEntries(scopes.map(scope => [scope, 0])) as Record<string, number>;
    const limits: number[] = [];
    let enabledCount = 0;
    let alertThresholdCount = 0;
    for (const [index, policy] of policies.entries()) {
      if (!isRecord(policy)) throw new Error(`Billing policy ${index} must be an object`);
      requireExactKeys(policy, [
        'id', 'scope', 'subjectId', 'period', 'limitCredits', 'alertThresholdCredits',
        'enabled', 'createdAt', 'updatedAt',
      ], `Billing policy ${index}`);
      boundedString(requirePresent(policy, 'id', `Billing policy ${index}`), `Billing policy ${index} id`);
      boundedString(requirePresent(policy, 'subjectId', `Billing policy ${index}`), `Billing policy ${index} subjectId`);
      boundedString(requirePresent(policy, 'createdAt', `Billing policy ${index}`), `Billing policy ${index} createdAt`);
      boundedString(requirePresent(policy, 'updatedAt', `Billing policy ${index}`), `Billing policy ${index} updatedAt`);
      const scope = requirePresent(policy, 'scope', `Billing policy ${index}`);
      if (typeof scope !== 'string' || !scopes.includes(scope as typeof scopes[number])) {
        throw new Error(`Billing policy ${index} has an unsupported scope`);
      }
      if (requirePresent(policy, 'period', `Billing policy ${index}`) !== 'monthly') {
        throw new Error(`Billing policy ${index} has an unsupported period`);
      }
      const enabled = requirePresent(policy, 'enabled', `Billing policy ${index}`);
      if (typeof enabled !== 'boolean') throw new Error(`Billing policy ${index} enabled must be boolean`);
      const limit = finiteNumber(requirePresent(policy, 'limitCredits', `Billing policy ${index}`), `Billing policy ${index} limitCredits`);
      if (limit <= 0) throw new Error(`Billing policy ${index} limitCredits must be positive`);
      const thresholds = policy.alertThresholdCredits === undefined ? [] : policy.alertThresholdCredits;
      if (!Array.isArray(thresholds) || thresholds.length > 5) {
        throw new Error(`Billing policy ${index} has invalid alert thresholds`);
      }
      for (const [thresholdIndex, threshold] of thresholds.entries()) {
        if (finiteNumber(threshold, `Billing policy ${index} threshold ${thresholdIndex}`) < 0) {
          throw new Error(`Billing policy ${index} threshold ${thresholdIndex} must be nonnegative`);
        }
      }
      scopeCounts[scope] += 1;
      enabledCount += enabled ? 1 : 0;
      alertThresholdCount += thresholds.length;
      limits.push(limit);
    }
    return {
      ok: true,
      path,
      status: 200,
      policyCount: policies.length,
      enabledCount,
      disabledCount: policies.length - enabledCount,
      scopeCounts,
      totalMonthlyLimitCredits: checkedSum(limits, 'Billing policy limits'),
      alertThresholdCount,
    };
  } catch {
    return schemaDrift(path);
  }
}

async function billingGrantsSummary(context: McpCommandContext): Promise<CommandResult> {
  validateInvocation(context);
  const path = '/api/billing/grants';
  const result = await readApi(context.client, path, { limit: BILLING_GRANT_LIMIT });
  if (!result.ok) return projectFailure(path, result);
  try {
    const grants = bodyResource(result.body, 'grants', 'Billing grants');
    requireExactKeys(grants, ['grants'], 'Billing grants');
    const rows = requirePresent(grants, 'grants', 'Billing grants');
    if (!Array.isArray(rows) || rows.length > BILLING_GRANT_LIMIT) {
      throw new Error('Billing grants exceed the row ceiling');
    }
    const amounts = rows.map((row, index) => {
      if (!isRecord(row)) throw new Error(`Billing grant ${index} must be an object`);
      requireExactKeys(row, ['id', 'createdAt', 'source', 'description', 'amountCredits'], `Billing grant ${index}`);
      boundedString(requirePresent(row, 'id', `Billing grant ${index}`), `Billing grant ${index} id`);
      boundedString(requirePresent(row, 'createdAt', `Billing grant ${index}`), `Billing grant ${index} createdAt`);
      boundedString(requirePresent(row, 'source', `Billing grant ${index}`), `Billing grant ${index} source`);
      if (row.description !== undefined) nullableBoundedString(row.description, `Billing grant ${index} description`);
      return finiteNumber(requirePresent(row, 'amountCredits', `Billing grant ${index}`), `Billing grant ${index} amountCredits`);
    });
    return {
      ok: true,
      path,
      status: 200,
      limit: BILLING_GRANT_LIMIT,
      grantCount: rows.length,
      totalAmountCredits: checkedSum(amounts, 'Billing grant amounts'),
    };
  } catch {
    return schemaDrift(path);
  }
}

async function billingSummaryGet(context: McpCommandContext): Promise<CommandResult> {
  validateInvocation(context);
  const path = '/api/billing/summary';
  const result = await readApi(context.client, path);
  if (!result.ok) return projectFailure(path, result);
  try {
    const billing = bodyResource(result.body, 'billing', 'Billing summary');
    requireExactKeys(billing, [
      'customerId', 'featureId', 'grantedCredits', 'remainingCredits', 'usedCredits',
      'heldCredits', 'available', 'nextResetAt',
    ], 'Billing summary');
    boundedString(requirePresent(billing, 'customerId', 'Billing summary'), 'Billing customerId');
    boundedString(requirePresent(billing, 'featureId', 'Billing summary'), 'Billing featureId');
    const available = requirePresent(billing, 'available', 'Billing summary');
    if (typeof available !== 'boolean') throw new Error('Billing available must be boolean');
    if (billing.nextResetAt !== undefined) {
      nullableBoundedString(billing.nextResetAt, 'Billing nextResetAt');
    }
    return {
      ok: true,
      path,
      status: 200,
      available,
      credits: {
        granted: finiteNumber(billing.grantedCredits, 'Billing grantedCredits', 0),
        remaining: finiteNumber(billing.remainingCredits, 'Billing remainingCredits', 0),
        used: finiteNumber(billing.usedCredits, 'Billing usedCredits', 0),
        held: finiteNumber(billing.heldCredits, 'Billing heldCredits', 0),
      },
    };
  } catch {
    return schemaDrift(path);
  }
}

async function billingPlanGet(context: McpCommandContext): Promise<CommandResult> {
  validateInvocation(context);
  const path = '/api/billing/plan';
  const result = await readApi(context.client, path);
  if (!result.ok) return projectFailure(path, result);
  try {
    const plan = bodyResource(result.body, 'plan', 'Billing plan');
    requireExactKeys(plan, ['plan', 'billingInterval', 'sandboxIdleMinutes', 'seatCount'], 'Billing plan');
    if (plan.plan !== 'pro' && plan.plan !== 'scale') throw new Error('Unsupported billing plan');
    if (plan.billingInterval !== 'monthly' && plan.billingInterval !== 'annual') {
      throw new Error('Unsupported billing interval');
    }
    const sandboxIdleMinutes = integer(requirePresent(plan, 'sandboxIdleMinutes', 'Billing plan'), 'Billing sandboxIdleMinutes', 5);
    if (sandboxIdleMinutes > 1_440) throw new Error('Billing sandboxIdleMinutes exceeds the ceiling');
    return {
      ok: true,
      path,
      status: 200,
      plan: {
        name: plan.plan,
        billingInterval: plan.billingInterval,
        sandboxIdleMinutes,
        seatCount: integer(requirePresent(plan, 'seatCount', 'Billing plan'), 'Billing seatCount', 1),
      },
    };
  } catch {
    return schemaDrift(path);
  }
}

function validatePendingChange(value: unknown): CommandResult | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error('Pending billing change must be an object');
  requireExactKeys(value, ['plan', 'billingInterval', 'paidSeatQuantity', 'effectiveAt'], 'Pending billing change');
  if (value.plan !== 'pro' && value.plan !== 'scale') throw new Error('Unsupported pending billing plan');
  if (value.billingInterval !== 'monthly' && value.billingInterval !== 'annual') {
    throw new Error('Unsupported pending billing interval');
  }
  boundedString(requirePresent(value, 'effectiveAt', 'Pending billing change'), 'Pending effectiveAt');
  return {
    plan: value.plan,
    billingInterval: value.billingInterval,
    paidSeatQuantity: integer(requirePresent(value, 'paidSeatQuantity', 'Pending billing change'), 'Pending paidSeatQuantity', 1),
  };
}

function validateLatestInvoice(value: unknown): { present: boolean; status: string | null } {
  if (value === null) return { present: false, status: null };
  if (!isRecord(value)) throw new Error('Latest invoice must be an object');
  requireExactKeys(value, [
    'id', 'status', 'amountDue', 'amountPaid', 'billingReason', 'currency',
    'hostedInvoiceUrl', 'invoicePdf', 'nextPaymentAttempt',
  ], 'Latest invoice');
  boundedString(requirePresent(value, 'id', 'Latest invoice'), 'Latest invoice id');
  integer(requirePresent(value, 'amountDue', 'Latest invoice'), 'Latest invoice amountDue', 0);
  integer(requirePresent(value, 'amountPaid', 'Latest invoice'), 'Latest invoice amountPaid', 0);
  nullableBoundedString(requirePresent(value, 'billingReason', 'Latest invoice'), 'Latest invoice billingReason');
  boundedString(requirePresent(value, 'currency', 'Latest invoice'), 'Latest invoice currency');
  if (value.hostedInvoiceUrl !== null) validateUrl(value.hostedInvoiceUrl, 'Latest hostedInvoiceUrl');
  if (value.invoicePdf !== null) validateUrl(value.invoicePdf, 'Latest invoicePdf');
  nullableBoundedString(requirePresent(value, 'nextPaymentAttempt', 'Latest invoice'), 'Latest nextPaymentAttempt');
  return {
    present: true,
    status: projectAllowlistedStatus(
      requirePresent(value, 'status', 'Latest invoice'),
      'Latest invoice status',
      INVOICE_STATUS_ALLOWLIST,
    ),
  };
}

async function billingSubscriptionStatus(context: McpCommandContext): Promise<CommandResult> {
  validateInvocation(context);
  const path = '/api/billing/subscription';
  const result = await readApi(context.client, path);
  if (!result.ok) return projectFailure(path, result);
  try {
    const subscription = bodyResource(result.body, 'subscription', 'Billing subscription');
    requireExactKeys(subscription, [
      'configured', 'hasBillingHistory', 'subscriptionId', 'plan', 'billingInterval', 'status',
      'entitlementActive', 'entitlementSource', 'trialExpiresAt', 'paidSeatQuantity',
      'currentPeriodStart', 'currentPeriodEnd', 'cancelAtPeriodEnd', 'graceEndsAt',
      'paymentActionUrl', 'pendingChange', 'latestInvoice',
    ], 'Billing subscription');
    const configured = requirePresent(subscription, 'configured', 'Billing subscription');
    const entitlementActive = requirePresent(subscription, 'entitlementActive', 'Billing subscription');
    const cancelAtPeriodEnd = requirePresent(subscription, 'cancelAtPeriodEnd', 'Billing subscription');
    if (typeof configured !== 'boolean' || typeof entitlementActive !== 'boolean' || typeof cancelAtPeriodEnd !== 'boolean') {
      throw new Error('Billing subscription booleans are invalid');
    }
    if (subscription.hasBillingHistory !== undefined && typeof subscription.hasBillingHistory !== 'boolean') {
      throw new Error('Billing hasBillingHistory must be boolean');
    }
    nullableBoundedString(requirePresent(subscription, 'subscriptionId', 'Billing subscription'), 'Billing subscriptionId');
    if (subscription.plan !== null && subscription.plan !== 'pro' && subscription.plan !== 'scale') {
      throw new Error('Unsupported subscription plan');
    }
    if (
      subscription.billingInterval !== null
      && subscription.billingInterval !== 'monthly'
      && subscription.billingInterval !== 'annual'
    ) throw new Error('Unsupported subscription billing interval');
    if (
      subscription.entitlementSource !== null
      && subscription.entitlementSource !== 'stripe'
      && subscription.entitlementSource !== 'trial'
    ) throw new Error('Unsupported entitlement source');
    if (subscription.paymentActionUrl !== null) validateUrl(subscription.paymentActionUrl, 'Billing paymentActionUrl');
    nullableBoundedString(requirePresent(subscription, 'trialExpiresAt', 'Billing subscription'), 'Billing trialExpiresAt');
    nullableBoundedString(requirePresent(subscription, 'currentPeriodStart', 'Billing subscription'), 'Billing currentPeriodStart');
    nullableBoundedString(requirePresent(subscription, 'currentPeriodEnd', 'Billing subscription'), 'Billing currentPeriodEnd');
    nullableBoundedString(requirePresent(subscription, 'graceEndsAt', 'Billing subscription'), 'Billing graceEndsAt');
    const latestInvoice = validateLatestInvoice(requirePresent(subscription, 'latestInvoice', 'Billing subscription'));
    return {
      ok: true,
      path,
      status: 200,
      subscription: {
        configured,
        hasBillingHistory: subscription.hasBillingHistory === true,
        plan: subscription.plan,
        billingInterval: subscription.billingInterval,
        status: projectAllowlistedStatus(
          requirePresent(subscription, 'status', 'Billing subscription'),
          'Billing status',
          SUBSCRIPTION_STATUS_ALLOWLIST,
        ),
        entitlementActive,
        paidSeatQuantity: nullablePositiveInteger(requirePresent(subscription, 'paidSeatQuantity', 'Billing subscription'), 'Billing paidSeatQuantity'),
        cancelAtPeriodEnd,
        paymentActionRequired: subscription.paymentActionUrl !== null,
        pendingChange: validatePendingChange(requirePresent(subscription, 'pendingChange', 'Billing subscription')),
        latestInvoicePresent: latestInvoice.present,
        latestInvoiceStatus: latestInvoice.status,
      },
    };
  } catch {
    return schemaDrift(path);
  }
}

export const usageBillingCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'usage-summary-get',
    description: 'Read redacted aggregate usage totals for exactly 7, 30, or 90 days',
    transport: 'mcp',
    validate: validateUsageInvocation,
    run: usageSummaryGet,
  },
  {
    name: 'billing-budgets-summary',
    description: 'Summarize bounded workspace billing policies without resource identifiers',
    transport: 'mcp',
    validate: context => validateInvocation(context),
    run: billingBudgetsSummary,
  },
  {
    name: 'billing-grants-summary',
    description: 'Summarize at most ten recent billing grants without sources or descriptions',
    transport: 'mcp',
    validate: context => validateInvocation(context),
    run: billingGrantsSummary,
  },
  {
    name: 'billing-summary-get',
    description: 'Read safe aggregate workspace credit availability without customer identifiers',
    transport: 'mcp',
    validate: context => validateInvocation(context),
    run: billingSummaryGet,
  },
  {
    name: 'billing-plan-get',
    description: 'Read the current plan, interval, sandbox idle setting, and seat count',
    transport: 'mcp',
    validate: context => validateInvocation(context),
    run: billingPlanGet,
  },
  {
    name: 'billing-subscription-status',
    description: 'Read redacted subscription and entitlement status without invoice or payment URLs',
    transport: 'mcp',
    validate: context => validateInvocation(context),
    run: billingSubscriptionStatus,
  },
];
