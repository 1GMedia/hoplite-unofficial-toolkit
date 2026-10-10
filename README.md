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

This is a toolkit, not a complete SDK. The internal typed API transport is
separate from CLI policy; it is not a standalone authorization layer.

## Documentation and current upstream support

Reviewed against [Hoplite's documentation](https://hoplite.sh/docs) on
**2026-10-05**. Choose an interface before configuring credentials or sending work:

| Interface | Use it for | Local guide |
| --- | --- | --- |
| Official CLI | Interactive coding, scripted `ask`, shells, push and handoff | [CLI setup and migration](docs/official-cli.md) |
| ACP | Local editor bridge or a custom remote session client | [ACP integration](docs/acp.md) |
| MCP | Let an external agent drive Hoplite using hosted tools | [MCP setup and safety](docs/mcp-server.md) |
| Direct API | Structured automation with explicit keys and guarded operations | [API support matrix](docs/api.md) |

These guides distinguish upstream capabilities from implemented toolkit
commands. The toolkit does not implement ACP or proxy the official CLI, and
its local mutation policy does not protect calls made outside this toolkit.
All 20 tracked public API operations still match the pinned contract; the
current documentation review did not require an API snapshot change.

## Use alongside the official CLI

Use official `hoplite` for interactive coding, `ask`, sandbox shells, local-change
push, handoff, and ACP. Use this companion for bounded operational reads and
guarded actions. It does not replace the official terminal experience. The
distinct `bun run hoplite-toolkit -- ...` alias avoids command-name confusion;
the existing `bun run hoplite -- ...` alias remains supported. Official `status`
reports local CLI configuration; toolkit `status` scans tasks.

The hosted MCP transport remains the default at `https://api.hoplite.sh/mcp`.
An explicitly set `HOPLITE_API_KEY` (`hop_...` or `hop_svc_...`) takes precedence;
unset it to use the OAuth file from `hoplite mcp start`. Invalid configured keys
fail closed without falling back to another identity. Keys never enter CLI args.

```bash
bun run hoplite-toolkit -- operations
bun run hoplite-toolkit -- mcp-api --path /api/model-providers
```

`operations` invokes advertised `hoplite_list_api_operations` discovery;
`mcp-api` offers bounded GET/HEAD coverage through `hoplite_call_api`. Discovery
does not grant write authorization. Generic writes stay disabled: use dedicated
commands, an exact allowlist entry, `--confirm`, and an explicit
`--client-operation-id` (now required for **every** write, including direct API
transport). See [hosted MCP](docs/mcp-server.md) for limits and remaining gaps.

Dedicated documented commands
can instead use `--transport api` with an explicitly configured API key:

```bash
# Inject HOPLITE_API_KEY through your local secret manager or CI secret settings.
bun run hoplite-toolkit -- api-auth
bun run hoplite-toolkit -- projects --transport api
bun run hoplite-toolkit -- threads --transport api --limit 20
bun run hoplite-toolkit -- thread-active-run fixturethread --transport api
bun run hoplite-toolkit -- thread-run-state fixturethread --transport api --run-id fixture-run
bun run hoplite-toolkit -- thread-runs fixturethread --transport api --limit 10
```

API transport supports `projects`, `threads`, `project`, `repositories`,
`branches`, `repo-inspect`, `messages`, the three run reads above, `thread-usage`,
`thread-pr-status`, `thread-pr-comments`, `create-thread`, `message`,
`thread-stop`, `thread-retry`, and `thread-compact`. Other commands remain MCP-only;
there is no silent fallback. API output uses a bounded, redacted envelope with
HTTP status and operation/request IDs when supplied by the server. An HTTP
failure returns `ok: false` and a nonzero process exit status. A successful
write is still only acceptance, not agent completion.

`api-auth` checks local configuration, not server validity or permissions.
Official CLI sign-in keys and the macOS Keychain are not read automatically.
`HOPLITE_CREDENTIALS_PATH` explicitly enables the legacy JSON adapter, requiring
one key matching the endpoint and optional `HOPLITE_ORG_ID`; ambiguous entries
fail closed. `HOPLITE_BASE_URL` is supported; the existing
`HOPLITE_API_BASE_URL` takes precedence. API endpoints must be HTTPS origins.
MCP OAuth follows `XDG_CONFIG_HOME` or the explicit `HOPLITE_OAUTH_PATH` override.
Keep official session credentials separate from automation credentials.

See [upstream maintenance](docs/upstream-maintenance.md) for the API drift
check, intentional updates, and the next stages of the companion roadmap.

## Use cases

### Check authentication before an operation

Check that the local OAuth file exists, has safe permissions, and has an
unexpired token without displaying credential values. This local check does
not contact the server or prove that refresh will succeed:

```bash
bun run hoplite -- auth
```

Actual MCP commands attempt refresh when needed. See the
[authentication boundaries](docs/mcp-server.md#authentication-choices) before
switching between official CLI sign-in, MCP OAuth, and direct API keys.

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
export HOPLITE_MUTATION_ALLOWLIST='project:fixtureproject'
bun run hoplite -- create-thread fixtureproject \
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

### What this does not prove

An HTTP success response proves that Hoplite accepted a request. It does not
prove that an agent completed the task, a remote process stayed alive, a test
passed, or a deployment succeeded. Verify those outcomes using fresh task
output and the appropriate external runtime evidence.

## Setup

Requirements: Bun and a Hoplite account. The default MCP workflow also needs
the official Hoplite CLI for browser authorization; direct API transport uses
an explicitly configured key instead.

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
```

Run `bun run hoplite -- help` for the complete command inventory.

## Mutations fail closed

No thread may be changed unless its exact ID is configured locally:

```bash
export HOPLITE_MUTATION_ALLOWLIST='thr_example1,thr_example2'
```

Every mutation also requires `--confirm`. Task creation requires an explicit
idempotency key, and stopping a task requires the exact run ID.

Creation additionally requires `project:<project-id>` in the allowlist, using
the actual project ID (not the example). Project entries do not authorize
existing-thread actions. Current unprefixed IDs and legacy `thr_...` IDs are
accepted; copy the exact ID returned by Hoplite. Generic `api` access is now
GET/HEAD-only and still restricted to an allowlisted thread; use dedicated
commands for writes. The API transport sends `Idempotency-Key`, matching the
body's operation/message ID, and never automatically retries a write.

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

## Install the Codex skill

Clone the full repository, then symlink the skill so its CLI wrapper can reach
the toolkit package:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s "$(pwd)/skills/hoplite-cli" \
  "${CODEX_HOME:-$HOME/.codex}/skills/hoplite-cli"
```

Restart Codex after adding the skill.

## Install as a plugin

The Claude Code, Cursor, and Codex plugins bundle **both** `hoplite-cli` and
`hoplite-env-import` from this repository, plus the hosted MCP server at
`https://api.hoplite.sh/mcp`. Use a current client with plugin support. Keep the
full repository tree: the CLI skill imports `packages/cli`. Run
`bun install --frozen-lockfile` at the active plugin root, including in a copied
or cached installation, before using that skill; the ENV helper needs Python 3.
There are no automatic install hooks.

Inject `HOPLITE_API_KEY` securely into the client process environment before
launching it; never paste a key into a manifest. Each client uses its own env
reference syntax. Prefer a project-restricted, read-only key and leave automatic
tool approval off. Direct hosted MCP calls **do not inherit** the toolkit's
allowlist, `--confirm`, idempotency, exact-run, or output-redaction safeguards.
Use the guarded CLI for operations; never use raw MCP to bypass a refusal.
Disable the hosted server in the client if those boundaries cannot be enforced.

- **Claude Code:** load this checkout for the session with
  `claude --plugin-dir /absolute/path/to/checkout`. Skills appear as
  `/hoplite-toolkit:hoplite-cli` and `/hoplite-toolkit:hoplite-env-import`.
  See the [plugin format](https://code.claude.com/docs/en/plugins-reference).
- **Cursor:** copy a clean full checkout (including hidden plugin directories,
  excluding credentials) to `~/.cursor/plugins/local/hoplite-toolkit`, install
  its Bun dependencies, then run **Developer: Reload Window** and check
  **Customize**. External-target symlinks are not supported; organization policy
  may disable local imports. See [local plugin installation](https://cursor.com/docs/plugins#test-plugins-locally)
  and the [manifest reference](https://cursor.com/docs/reference/plugins).
- **Codex:** from this checkout run `codex plugin marketplace add .`, then
  `codex plugin add hoplite-toolkit@hoplite-toolkit-local`, and start a new
  session. The included local marketplace points to the full repository root.
  See [plugin packaging and local installation](https://developers.openai.com/plugins/build/plugins).

This is local plugin packaging, not a listing in any official marketplace.

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

### Generated API operations

Direct and Platform operation types/metadata are generated from committed public
spec snapshots. Run `bun run operations:generate` after a reviewed input update;
CI enforces `bun run operations:check`. See [generation and safety boundaries](docs/generated-operations.md).
