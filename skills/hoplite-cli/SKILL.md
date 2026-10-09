---
name: hoplite-cli
description: Inspect and operate Hoplite tasks through the unofficial guarded CLI when a request involves Hoplite authentication, projects, threads, timelines, repositories, or explicitly approved task actions.
---

# Hoplite CLI

Use the bundled wrapper instead of browser automation when its MCP/API surface
covers the request.

Use the official CLI for interactive sessions, sandbox shell/exec, handoff,
push, and ACP. This skill is the operational companion, not a replacement.
Dedicated documented commands can opt into `--transport api` with an injected
`HOPLITE_API_KEY`; MCP remains the default. Never scrape official credential
storage or copy Keychain keys. `api-auth` is a local check, not server validation.

## Choose the interface

Reviewed against official docs on 2026-10-05. Read the repository guides when
configuring an integration:

- [Official CLI](../../docs/official-cli.md): session sign-in and scripted `ask`.
- [ACP](../../docs/acp.md): official local editor bridge or remote session API;
  this toolkit does not implement an ACP transport.
- [MCP](../../docs/mcp-server.md): external-client OAuth/API-key setup. This
  toolkit's MCP transport uses an explicit `HOPLITE_API_KEY` first, otherwise OAuth.
  Unset the variable to choose OAuth; invalid keys do not fall back.
- [API](../../docs/api.md): implemented direct-API commands and upstream-only
  capabilities; the Platform API is a separate unsupported surface.

Our allowlists and confirmation flags apply only inside this toolkit. Never
switch to the official CLI, ACP, or raw MCP tools to bypass a refused action.
Do not infer capability support merely because upstream documents it.

## Authentication

Never print, copy, upload, or commit OAuth/API credentials. Check the stored
OAuth state without exposing tokens:

```bash
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts auth
```

This inspects local expiry/permissions only; it does not refresh or verify the
session remotely. Normal MCP commands attempt OAuth refresh when needed.

If authentication is missing, expired, or cannot refresh, ask the operator to
run the official interactive flow:

```bash
hoplite mcp start
```

Use `operations` for advertised `hoplite_list_api_operations` discovery and
`mcp-api --path /api/model-providers` for generic hosted GET/HEAD reads.
Discovery does not authorize writes. Dedicated writes retain exact allowlists,
confirmation, explicit operation IDs, and exact-run stop guards.

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

`thread-stop` additionally requires the exact current run ID. Every write requires an explicit `--client-operation-id` (maximum 64 characters). Do not retry a mutation with a different
operation ID when the first result is ambiguous.

Creation also requires `project:<project-id>` in the mutation allowlist. That
entry grants creation only, not actions on existing threads. Use exact IDs from
read results; both current unprefixed and legacy `thr_...` IDs are accepted.
Generic `api` is GET/HEAD-only; it cannot be used to bypass dedicated guards.

Use `thread-active-run` to identify a current run, `thread-run-state --run-id ID`
for authoritative state, and bounded `thread-runs --limit N` for history.
Do not equate a run state or accepted write with verified downstream outcomes.

Do not guess undocumented routes or payloads. Archive/update, delete,
checkpoint restore, PR mutations, terminal/log access, attachments, billing,
and workspace recovery remain outside the dedicated command surface.

## Completion evidence

Report which command ran, its target, the returned receipt, and whether any
Hoplite state changed. Treat HTTP acceptance separately from verified task
completion.
