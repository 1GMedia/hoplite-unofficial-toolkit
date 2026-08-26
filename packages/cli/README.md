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

## Project environment metadata

`project-environment-list` reads the reviewed environment metadata route and
prints only sorted variable names plus optional update timestamps:

```bash
bun run hoplite -- project-environment-list <project-id>
```

The command accepts no value-selection option and never prints variable
values. It fails closed if the server returns a value, credential,
secret-bearing field, unknown field, more than 500 entries, or an incompatible
schema. Its local implementation is
available, but authentication compatibility for this client-derived route
remains unverified. Environment set/unset operations are intentionally absent
until a dedicated secret-input subsystem and approved authentication evidence
exist.
