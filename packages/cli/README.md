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
bun run hoplite -- workspace-members-status
```

These local commands do not authenticate or change Hoplite state.
`workspace-members-status` reports only fixed browser-session compatibility
metadata. It does not list members or invitations, call the authenticated
client routes, or enable invite, role, removal, cancellation, or domain writes.

Feature command modules export typed definitions and are composed by
`src/command-registry.ts`. New project/workspace feature lanes should add an
isolated command module and register its definition group in the composition
root; they do not need to extend the legacy command switch.
