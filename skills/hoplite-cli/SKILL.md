---
name: hoplite-cli
description: Inspect and operate Hoplite tasks through the unofficial guarded CLI when a request involves Hoplite authentication, projects, threads, timelines, repositories, or explicitly approved task actions.
---

# Hoplite CLI

Use the bundled wrapper instead of browser automation when its MCP/API surface
covers the request.

## Authentication

Never print, copy, upload, or commit OAuth/API credentials. Check the stored
OAuth state without exposing tokens:

```bash
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts auth
```

If authentication is missing, expired, or cannot refresh, ask the operator to
run the official interactive flow:

```bash
hoplite mcp start
```

## Read workflow

Start with the smallest relevant read:

```bash
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts projects
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts threads
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts inspect <thread-id>
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts repositories
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts messages <thread-id> --limit 100
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts settings-capabilities
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts compatibility-status
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts usage-summary-get --days 30
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts billing-budgets-summary
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts billing-grants-summary
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts billing-summary-get
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts billing-plan-get
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts billing-subscription-status
```

Keep timeline and API output bounded. Task states such as `ready` or `running`
do not prove that downstream work actually progressed.

Use `settings-capabilities --area <area>` to distinguish implemented commands
from authenticated-client contracts that are only discovered or blocked. A
registry entry is evidence, not permission to call an undocumented write.
Compare a previously redirected JSON snapshot with:

```bash
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts compatibility-diff \
  --baseline <snapshot.json>
```

Usage and billing reads are authenticated-client compatibility surfaces, not
public OpenAPI promises. `usage-summary-get` accepts only the exact strings
`--days 7`, `30`, or `90`; numeric variants such as `07` or `30.0` are rejected
before OAuth is read. All other billing commands accept no flags or
positionals. The commands emit only aggregate usage, policy/grant counts, safe
credit aggregates, plan configuration, and redacted entitlement/subscription
status. They intentionally
omit customer, subscription, invoice, policy, subject, and grant identifiers;
provider/model/user details; descriptions and sources; invoice amounts; and all
provider timestamps and invoice/payment URLs. Treat `unsupported_credential`,
`subscription_required`, `role_denied`, `absent_or_unavailable`,
`deployment_unavailable`, `request_failed`, and `schema_drift` as distinct
results and do not retry automatically.
Only the evidenced subscription status `active` and latest-invoice status
`open` may be emitted. Any other provider status is returned as `unknown`; do
not infer or print the original value.

## Mutations

Mutations are disabled when `HOPLITE_MUTATION_ALLOWLIST` is empty. For an
approved action, resolve the exact thread ID read-only, verify it is locally
allowlisted, use a stable operation ID, and add `--confirm`:

```bash
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts message \
  <thread-id> \
  --text 'Continue the assigned task' \
  --client-operation-id <stable-operation-id> \
  --confirm
```

`thread-stop` additionally requires the exact current run ID. Task creation
requires an explicit idempotency key. Do not retry a mutation with a different
operation ID when the first result is ambiguous.

Do not guess undocumented routes or payloads. Archive/update, delete,
checkpoint restore, PR mutations, terminal/log access, attachments, billing
writes or provider handoffs, and workspace recovery remain outside the
dedicated command surface.

Budget/plan changes, checkout, trial activation, subscription preview or hosted
confirmation, cancellation, reactivation, top-up, and portal navigation remain
blocked metadata only. Never open a returned billing URL or attempt to recreate
one through the generic API command.

The generic `api` command is permanently `GET`/`HEAD`-only. Never attempt to
work around its canonical path checks or use it for a settings mutation. Future
project/workspace writes also require an owner-only expiring resource policy;
`resource-policy-check --file <policy.json>` validates that local prerequisite
without authorizing or changing Hoplite state.

## Completion evidence

Report which command ran, its target, the returned receipt, and whether any
Hoplite state changed. Treat HTTP acceptance separately from verified task
completion.
