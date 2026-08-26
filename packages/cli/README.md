# CLI package

Source for the toolkit's Bun/TypeScript command-line interface. Use the root
scripts for installation, testing, and builds.

The generic `api` command is read-only (`GET`/`HEAD`) and canonicalizes the
request path before fetch. Settings compatibility evidence and the future-write
resource policy live in `src/compatibility.ts` and are exposed through:

```bash
bun run hoplite -- settings-capabilities
bun run hoplite -- compatibility-status
bun run hoplite -- compatibility-diff --baseline <snapshot.json>
bun run hoplite -- resource-policy-check --file <policy.json>
```

These local commands do not authenticate or change Hoplite state.

Feature command modules export typed definitions and are composed by
`src/command-registry.ts`. New project/workspace feature lanes should add an
isolated command module and register its definition group in the composition
root; they do not need to extend the legacy command switch.

`src/usage-billing-commands.ts` contains authenticated-client compatibility
reads for aggregate usage and billing status. It implements only fixed-window
usage totals and bounded billing budgets, grants, credit, plan, and subscription
projections. The module performs one GET per command, caps raw MCP text before
JSON parsing, validates exact envelopes and response keys, bounds rows and
strings, and omits billing/customer/invoice identifiers and URLs. Financial or
subscription writes and browser handoffs remain capability metadata only.
