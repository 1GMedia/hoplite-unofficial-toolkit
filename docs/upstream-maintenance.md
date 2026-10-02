# Keeping the companion current

The official [CLI](https://hoplite.sh/docs/cli) owns interactive coding sessions,
sandbox shells, push, handoff, and ACP. This project owns guarded operational
automation, bounded evidence, and workflow policy. They can be installed and
used together without sharing private credential-storage internals.

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
Scheduled workflows run from the default branch after this change is merged.
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

## Evolution stages

1. **Foundation (this change):** explicit API auth, typed bounded transport,
   current/legacy IDs, documented writes, creation policy, run reads, drift CI.
2. **Run lifecycle:** durable event cursor/replay, monitoring, approval handling,
   and operation-receipt reconciliation with tested reconnect behavior.
3. **Delivery workflows:** multi-task orchestration and PR/verification gates.
   Replit deployment stays separate and explicitly authorized.

Future capabilities should prefer published contracts. Undocumented operations
remain isolated and clearly marked; public documentation does not eliminate
the need for separate authorization and safety design.
