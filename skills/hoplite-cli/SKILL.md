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
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts workspace-members-status
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

Workspace members are a browser-session boundary. Use
`workspace-members-status` to inspect the fixed local evidence record; it does
not authenticate, make a network request, or emit member/invitation personal
data. Better Auth member listing and mutation methods, plus the client-only
invitation and domain auto-join routes, are not proven compatible with CLI
OAuth or workspace API keys. Do not guess those contracts. Invite, role,
remove, cancel-invitation, and domain auto-join writes remain blocked.

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

## Completion evidence

Report which command ran, its target, the returned receipt, and whether any
Hoplite state changed. Treat HTTP acceptance separately from verified task
completion.
