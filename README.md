# Hoplite Unofficial Toolkit

An unofficial, guarded compatibility CLI and Codex skill for inspecting and
operating Hoplite through its OAuth MCP endpoint and evidenced API routes.

This project is not affiliated with, endorsed by, or maintained by Hoplite or
Carbon Copy Markets, Inc. Undocumented compatibility routes may change without
notice.

## What it contains

- `packages/cli` — Bun/TypeScript CLI with OAuth refresh, bounded output, and
  explicit mutation guardrails.
- `skills/hoplite-cli` — Codex skill that teaches an agent when and how to use
  the CLI safely.
- `docs` — route classification and the public-artifact reconstruction record.

This is a toolkit, not a complete SDK. The reusable client layer can be split
from the CLI if a stable programmatic API becomes useful.

## Use cases

### Check authentication before an operation

Confirm that the local OAuth session exists, has safe file permissions, and is
still refreshable without displaying credential values:

```bash
bun run hoplite -- auth
```

### Inventory projects and active tasks

List accessible projects, search active or archived threads, and generate a
bounded status summary without opening the Hoplite web interface:

```bash
bun run hoplite -- projects
bun run hoplite -- threads --status running
bun run hoplite -- threads --archived=true
bun run hoplite -- status
```

### Inspect a task before intervening

Read one task and its recent redacted timeline, then check whether it can
execute and how much usage it has accumulated:

```bash
bun run hoplite -- inspect <thread-id>
bun run hoplite -- thread-capability <thread-id>
bun run hoplite -- thread-usage <thread-id>
```

### Send a guarded follow-up message

Steer an existing allowlisted task without copying browser cookies or manually
using the Hoplite UI. The stable operation ID makes the attempted delivery
traceable:

```bash
export HOPLITE_MUTATION_ALLOWLIST='<thread-id>'
bun run hoplite -- message <thread-id> \
  --text 'Continue the assigned task and report verification evidence' \
  --client-operation-id follow-up-20260824-001 \
  --confirm
```

### Recover a stalled task deliberately

Stop an exact current run, retry a task, or compact its context. These actions
remain allowlist-only and require explicit confirmation:

```bash
bun run hoplite -- thread-stop <thread-id> --run-id <run-id> --confirm
bun run hoplite -- thread-retry <thread-id> --confirm
bun run hoplite -- thread-compact <thread-id> --confirm
```

### Create tasks idempotently

Create a new Hoplite task while supplying a stable operation ID so an ambiguous
network result can be reconciled safely instead of creating duplicates:

```bash
bun run hoplite -- create-thread <project-id> \
  --prompt 'Implement the requested change and run the relevant tests' \
  --client-operation-id create-task-20260824-001 \
  --confirm
```

### Inspect repository and delivery state

Discover repositories and branches exposed to Hoplite, then inspect pull
request and preview-verification state for a task:

```bash
bun run hoplite -- repositories
bun run hoplite -- branches <repository-id>
bun run hoplite -- repo-inspect <repository-id>
bun run hoplite -- thread-pr-status <thread-id>
bun run hoplite -- thread-pr-comments <thread-id>
bun run hoplite -- thread-preview-checklist <thread-id>
```

### Give Codex a safer Hoplite interface

Install the bundled skill so Codex can choose bounded reads by default and use
dedicated guarded commands when you explicitly approve a task mutation. This is
useful for task coordination, operational summaries, and repeatable recovery
workflows without teaching each Codex session the route details again.

### Inspect settings and compatibility coverage

The toolkit carries a sanitized registry of settings contracts currently
evidenced by the official OpenAPI and authenticated Hoplite client. The model
also distinguishes official-documentation and live-MCP sources when future
entries are actually verified from those tiers. Registry entries are evidence
records, not write permissions:

```bash
bun run hoplite -- settings-capabilities
bun run hoplite -- settings-capabilities --area project-mcp
bun run hoplite -- compatibility-status
bun run hoplite -- compatibility-status --area project-environment
```

Save a status result using shell redirection, then compare it after an update.
An `--area` filter is embedded in the snapshot and automatically reused by the
diff:

```bash
bun run hoplite -- compatibility-status > hoplite-compatibility.json
bun run hoplite -- compatibility-diff --baseline hoplite-compatibility.json
```

The snapshot records its OpenAPI and client identity, source tier, method and
path template, payload/caller evidence, side effects, observed authentication
status, risk class, implementation status, and last verification date. It never
contains credentials, settings values, browser state, or tenant data.

Account settings have a narrower local-only gap report:

```bash
bun run hoplite -- account-settings-capabilities
bun run hoplite -- account-settings-capabilities --area profile
bun run hoplite -- account-settings-capabilities --area personalization
bun run hoplite -- account-settings-capabilities --area preferences
```

The optional area is exact and the command never authenticates or reads cloud
state. It emits fixed capability, authentication, persistence, status, risk,
dependency, and evidence-tier enums plus implemented command names only; no
numeric counters or boolean state claims are part of the output contract.
Profile/session operations and the remaining personalization fields are Better
Auth browser-session boundaries. Personal memory and skill inventories are
identified as a separate PR #10 dependency, not duplicated on this branch.
Preferences are browser/device-local and are never reported as Hoplite cloud
state. All account-setting writes remain unavailable here.

### What this does not prove

An HTTP success response proves that Hoplite accepted a request. It does not
prove that an agent completed the task, a remote process stayed alive, a test
passed, or a deployment succeeded. Verify those outcomes using fresh task
output and the appropriate external runtime evidence.

## Setup

Requirements: Bun, the official Hoplite CLI, and a Hoplite account.

```bash
bun install
hoplite mcp start
bun run hoplite -- auth
bun run hoplite -- projects
```

The official OAuth flow stores credentials outside this repository. Never copy
tokens or credentials into source files.

## Read commands

```bash
bun run hoplite -- projects
bun run hoplite -- threads
bun run hoplite -- status
bun run hoplite -- inspect <thread-id>
bun run hoplite -- repositories
bun run hoplite -- branches <repository-id>
bun run hoplite -- messages <thread-id> --limit 100
bun run hoplite -- thread-capability <thread-id>
bun run hoplite -- thread-usage <thread-id>
bun run hoplite -- thread-pr-status <thread-id>
bun run hoplite -- account-settings-capabilities
```

Run `bun run hoplite -- help` for the complete command inventory.

## Mutations fail closed

No thread may be changed unless its exact ID is configured locally:

```bash
export HOPLITE_MUTATION_ALLOWLIST='thr_example1,thr_example2'
```

Every mutation also requires `--confirm`. Task creation requires an explicit
idempotency key, and stopping a task requires the exact run ID.

```bash
bun run hoplite -- message thr_example1 \
  --text 'Continue the assigned task' \
  --client-operation-id operator-20260824-001 \
  --confirm

bun run hoplite -- thread-stop thr_example1 \
  --run-id run_example1 \
  --client-operation-id operator-stop-001 \
  --confirm
```

An accepted request proves delivery only. It does not prove that a remote
agent, process, or application completed the requested work.

The generic `api` command is permanently restricted to `GET` and `HEAD`.
Caller-supplied paths are canonicalized once and reject literal or encoded dot
segments, separators, and backslashes before fetch. All writes must use a
dedicated command with an exact route and request schema:

```bash
bun run hoplite -- api --method GET --path /api/projects
```

Future project and workspace settings writes must also present an owner-owned,
owner-only (`0400` or `0600`) resource policy with a lifetime no longer than 24
hours.
The parser is available now for local validation, but no settings write consumes
it in this release:

```bash
chmod 400 hoplite-resource-policy.json
bun run hoplite -- resource-policy-check --file hoplite-resource-policy.json
```

See [compatibility routes](docs/compatibility.md) for the strict policy schema.

## Install the Codex skill

Clone the full repository, then symlink the skill so its CLI wrapper can reach
the toolkit package:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s "$(pwd)/skills/hoplite-cli" \
  "${CODEX_HOME:-$HOME/.codex}/skills/hoplite-cli"
```

Restart Codex after adding the skill.

## Development

```bash
bun run test
bun run typecheck
bun run build
```

See [compatibility routes](docs/compatibility.md) and the
[reverse-engineering record](docs/reverse-engineering.md).

## Security

Do not commit API keys, OAuth files, task transcripts, repository credentials,
or private thread identifiers. See [SECURITY.md](SECURITY.md).
