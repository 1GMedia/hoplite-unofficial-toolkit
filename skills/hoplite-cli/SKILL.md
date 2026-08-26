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
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts mcp-endpoint-check \
  --url https://mcp.vendor.dev/mcp
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts project-mcp-config-check \
  --file <owner-only-config.json>
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
checkpoint restore, PR mutations, terminal/log access, attachments, billing,
and workspace recovery remain outside the dedicated command surface.

The generic `api` command is permanently `GET`/`HEAD`-only. Never attempt to
work around its canonical path checks or use it for a settings mutation. Future
project/workspace writes also require an owner-only expiring resource policy;
`resource-policy-check --file <policy.json>` validates that local prerequisite
without authorizing or changing Hoplite state.

Before proposing a remote project MCP server, use `mcp-endpoint-check --url`
for the local syntactic policy. Use `--resolve` only when the operator wants a
DNS lookup: it performs one local resolver observation in an isolated child, no
HTTP request, and no Hoplite call. The three-second deadline kills and detaches
that child so it cannot keep the CLI alive; it does not prove cancellation of
all underlying OS resolver work. Treat returned addresses as time-specific
local evidence only. The result intentionally omits the raw URL and pathname.
Do not call the undocumented auth-analysis or probe POST routes; their CLI
credential compatibility and server-side network controls remain blocked.

For project MCP changes, validate the config first. Version 1 accepts only
HTTPS HTTP/SSE, no auth or a bearer environment secret reference, and bounded
tool scopes. Never add stdio, raw headers, token values, OAuth state, URL
credentials, or internal/private endpoints to make validation pass. Config,
policy, and before-state files must be current-user-owned regular files with
mode `0400` or `0600`.

`project-mcp-plan-add`, `project-mcp-plan-update`, and
`project-mcp-plan-remove` create local owner-only expiring artifacts only.
Supply exact account/workspace/origin identity flags matching an owner policy,
a stable client operation ID, and a new output path. Update/remove additionally
require a trusted, digest-valid current before-state; do not invent one. Remove
requires a W3 policy grant. Treat receipt digests as local planning evidence,
not evidence that Hoplite or an external MCP server changed. There is no remote
apply command, and agents must not substitute generic `api`, probe,
auth-analysis, OAuth, or browser writes.

## Completion evidence

Report which command ran, its target, the returned receipt, and whether any
Hoplite state changed. Treat HTTP acceptance separately from verified task
completion.
