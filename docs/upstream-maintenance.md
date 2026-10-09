# Keeping the companion current

The official [CLI](https://hoplite.sh/docs/cli) owns interactive coding sessions,
sandbox shells, push, handoff, and ACP. This project owns guarded operational
automation, bounded evidence, and workflow policy. They can be installed and
used together without sharing private credential-storage internals.

## Latest documentation review: 2026-10-05

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

The weekly/manual GitHub Actions workflow checks the public specification.
Failures appear as failed workflow runs; configure GitHub notification settings
if you want alerts. It does not patch code, create PRs, or refresh the pin.
Scheduled workflows run from the default branch.
Normal tests remain offline and use synthetic fixtures only.

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

The API check also does not monitor prose, MCP tool schemas, or ACP behavior.
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
