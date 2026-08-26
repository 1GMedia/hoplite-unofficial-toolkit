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
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts project-settings-get <project-id>
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts project-settings-resolve <project-id>
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts project-repository-get <project-id>
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts project-repository-resolve <project-id>
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts settings-capabilities
bun ~/.codex/skills/hoplite-cli/scripts/hoplite_cli.ts compatibility-status
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

Project settings reads omit shell commands and instructions by default. Add
`--show-commands` only when command text is necessary, and add
`--include-instructions` only when project instructions are necessary. Both
surfaces remain redacted and bounded. `project-settings-resolve` combines
non-null project command overrides with enabled repository commands while
preserving an explicitly disabled repository command.

The project read is public/OpenAPI evidence. Repository resolution uses the
authenticated-client compatibility route
`/api/projects/:id/repo-settings`; OAuth/MCP support for that route remains
unverified live. Treat `401`, `403`, and `404` as results for the current
credential and principal, not proof that the browser feature is unavailable.
Do not infer effective preview-port precedence from this command.

For a repository change, start with `project-repository-get` and retain its
`stateDigest`, then use `project-repository-resolve` to verify the Hoplite
repository ID, full name, default branch, saved base branch, and repo-settings
status. Do not treat a missing catalog match as proof that the binding is gone;
the current credential or provider catalog may be incomplete.

`project-repository-plan-bind` and `project-repository-plan-unbind` are local
W2 planning commands. They require an owner-only, maximum-24-hour resource
policy with the exact project and `project.repository.bind` or
`project.repository.unbind` capability, plus the before-state digest and a
stable client operation ID. A successful plan means the local policy matched;
it does not authorize or execute a remote write.

Never attempt repository apply through the generic API. The dedicated
`project-repository-apply` command is intentionally local and blocked because
PATCH OAuth authorization, strict name/script preservation, readback, and
ambiguous-result reconciliation are unverified. The exact unbind payload was
not observed, and the unbind plan's `local-inference` evidence tier does not
claim any remote route or method. Use Hoplite settings for the actual change
until those contracts are verified.

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
