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
