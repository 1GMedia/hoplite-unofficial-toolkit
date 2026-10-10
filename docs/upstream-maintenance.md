# Keeping the companion current

The official [CLI](https://hoplite.sh/docs/cli) owns interactive coding sessions,
sandbox shells, push, handoff, and ACP. This project owns guarded operational
automation, bounded evidence, and workflow policy. They can be installed and
used together without sharing private credential-storage internals.

## PR status contract review: 2026-10-09

The public `GET /api/threads/{id}/pr/status` schema no longer requires at least
one `allowedMergeMethods` entry and adds optional boolean `mergeQueueRequired`.
An empty list must stay empty; an absent queue flag must not be interpreted as
`false`. Neither field authorizes merging.

Reviewed the direct API and MCP read callers: both preserve these fields through
the shared bounded/redacted output handling, without a nonempty-array validator
or merge-method default. No runtime change is needed. Offline regression tests
cover empty methods and true/false/absent queue flags, plus detection of both
schema changes. Only this operation's pin was intentionally refreshed; the
other 19 operations are unchanged. The downloaded public spec matches all 20.

## Documentation review: 2026-10-05

| Authoritative source | Companion guidance |
| --- | --- |
| [Documentation home](https://hoplite.sh/docs) | Choose CLI, ACP, MCP, direct API, or Platform API explicitly |
| [CLI](https://hoplite.sh/docs/cli), [configuration](https://hoplite.sh/docs/cli/configuration), [ask](https://hoplite.sh/docs/cli/ask), [interactive](https://hoplite.sh/docs/cli/interactive) | [Setup, authentication, scripts, local-tool opt-in, and 2.x migration](official-cli.md) |
| [ACP](https://hoplite.sh/docs/cli/acp) | [Local bridge versus remote protocol](acp.md) |
| [MCP server](https://hoplite.sh/docs/cli/mcp-server) | [OAuth/API-key clients, limits, and toolkit boundaries](mcp-server.md) |
| [API reference](https://hoplite.sh/docs/api), [OpenAPI](https://hoplite.sh/docs/openapi.json) | [Implemented commands versus upstream-only features](api.md) |

The downloaded public spec matches all 20 pinned operations. This update is
documentation-only: no runtime parity claim, authenticated service test, or
blind snapshot refresh. Review dates record the evidence available that day,
not a guarantee that upstream will remain unchanged.

## Reviewed contracts, not silent upgrades

`docs/api-contract.json` pins the documented operations used by the toolkit.
The contract checker resolves referenced schemas and compares request/response
constraints, parameters, operation IDs, and routes. Descriptions/examples are
excluded to avoid editorial noise. It detects changes, not whether a deployment
actually implements the published contract.

```bash
# Offline check against a separately downloaded public specification.
bun run api:check --file /path/to/openapi.json
# Explicit unauthenticated public documentation download; no Hoplite mutations.
bun run api:check --live
```

The weekly/manual GitHub Actions workflow has two independent jobs: the strict
reviewed-contract check, and a broader snapshot monitor. Contract failures do not
prevent snapshot proposals. Neither job automatically refreshes the reviewed
`api-contract.json` pin. Normal tests remain offline and use synthetic fixtures.

## Broader upstream snapshots

`docs/upstream-snapshot.json` records SHA-256 content hashes for the full Direct
and Platform OpenAPI documents, `llms.txt`, the sorted/deduplicated docs URL list
from `sitemap.xml`, and every listed page in these exact families:
`/docs/cli`, `/docs/factory`, `/docs/platform`, `/docs/api`, and
`/docs/agent/mcp`. Family roots are also fetched even when absent from the
sitemap. Pages use `Accept: text/markdown`. No `lastmod` dependency is used.
New/deleted sitemap pages and changed page contents are detected. Other page
families are inventoried through the sitemap hash but their bodies are not read.
The npm CLI version is queried with `npm view @usehoplite/cli version`; nothing
is installed or upgraded.

Optional repository secret **HOPLITE_DRIFT_MCP_KEY** enables hosted MCP schema
discovery using a dedicated least-privilege read-only API/service-account key.
The collector initializes MCP and paginates `tools/list`, never `tools/call`.
It hashes canonically sorted tool definitions, not session IDs or response
metadata. No credential or tool body is saved in the snapshot or issue.
Without the secret, it explicitly skips MCP and retains the last known hash
(or omits it before the first authenticated check). A bad configured credential
fails collection rather than pretending the check was skipped. Live authenticated
MCP verification is not part of the offline test suite.

```bash
# Read-only comparison; exit 1 on drift, no local snapshot updates.
bun scripts/check-upstream-drift.ts --live
# Explicitly collect and refresh only the hash snapshot after successful reads.
bun scripts/check-upstream-drift.ts --live --write
```

The write mode also creates ignored `upstream-drift-summary.md` and emits
`changed`/`fingerprint` to `GITHUB_OUTPUT` when present. Sources have per-request
timeouts, 8 MiB body limits, restricted origins, no redirects/retries, four
parallel page downloads, and bounded page/tool inventories. A failed source
does not produce a partial snapshot. Only URLs, digests and the validated CLI
version appear in public diffs; response bodies and credentials are suppressed
on errors.

On a change, the workflow opens an **upstream-drift** labeled issue with old/new
hashes and a **draft** snapshot-only PR. Stable snapshot fingerprints identify
branches/issues, and concurrency prevents overlapping publication. Existing
proposals, including closed ones, are not recreated, force-pushed, marked ready,
or auto-merged. A changed fingerprint produces a new proposal. Publication only
runs from the default branch and never changes client code, dependencies,
authorization policy, or the reviewed contract pin.

Only the publishing job gets `contents: write` (necessary for the proposal
branch), `issues: write`, and `pull-requests: write`. The contract job has only
`contents: read`. The repository must allow GitHub Actions to create pull
requests; if organization policy forbids this, publication fails visibly rather
than falling back to a personal token. PRs created with `GITHUB_TOKEN` may not
trigger normal PR/push CI automatically; run the normal offline checks on any
proposal before review. Schedules become active after this stack merges into
the default branch. No automation is enabled merely by opening this draft.

When drift is reported:

1. Review the changed operations in the API reference and downloaded spec.
2. Update the client/command validation and offline fixtures together; preserve
   mutation gates and do not retry ambiguous writes.
3. Intentionally regenerate the pin using the checker's `--help` instructions;
   review the diff rather than accepting the latest contract blindly.
4. Run tests, typecheck, build, and the contract check; submit a reviewed PR.

This checks a subset of the public API, not the official CLI binary or all API
features. Review CLI release notes/docs before changing delegated interactive
workflows; there is no automatic official CLI upgrade.

The strict API check does not monitor prose or MCP tool schemas; the broader
snapshot monitor detects their changes but does not certify ACP behavior.
On each upstream release or requested documentation refresh, re-read the linked
sources and update the interface guides, README, and agent skill together.
Check auth precedence, platform support, mutation semantics, output limits,
session/replay behavior, and examples against current code. Keep conflicting
upstream claims explicit (such as MCP versus REST stop behavior); do not weaken
local policy or invent route aliases to reconcile them. Only change the pin
after a reviewed structural contract change and matching implementation/tests.

## Evolution stages

1. **Foundation (implemented):** explicit API auth, typed bounded transport,
   current/legacy IDs, documented writes, creation policy, run reads, drift CI.
2. **Run lifecycle:** durable event cursor/replay, monitoring, approval handling,
   and operation-receipt reconciliation with tested reconnect behavior.
3. **Delivery workflows:** multi-task orchestration and PR/verification gates.
   Replit deployment stays separate and explicitly authorized.

Future capabilities should prefer published contracts. Undocumented operations
remain isolated and clearly marked; public documentation does not eliminate
the need for separate authorization and safety design.

## Offline operation generation

See [generated operations](generated-operations.md) for the committed Direct and
Platform inputs, generated request/response types, metadata semantics, and CI
staleness check. Regenerating these outputs does not approve new writes or refresh
the separately reviewed contract pin.
