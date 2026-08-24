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
```

Keep timeline and API output bounded. Task states such as `ready` or `running`
do not prove that downstream work actually progressed.

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

## Completion evidence

Report which command ran, its target, the returned receipt, and whether any
Hoplite state changed. Treat HTTP acceptance separately from verified task
completion.
