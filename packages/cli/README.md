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

`src/project-mcp-commands.ts` implements the read-only MCP discovery lane:

```bash
bun run hoplite -- project-mcp-list <project-id>
bun run hoplite -- project-mcp-catalog
```

Both commands make one `hoplite_call_api` request with a fixed `GET` route and
no retry. Response schemas fail closed, rows and strings are bounded, and the
projection omits URLs, headers, environment maps, local execution details, and
credential material. Authentication compatibility remains `unverified` until
the route is confirmed with a supported non-browser credential.

Catalog results distinguish the current page size from an optional server
global total. `hasMore` is true when either the explicit flag or a validated
next-cursor presence says another page exists, but raw cursors are not emitted.
For OAuth servers, only pending/connected status derived from the evidenced auth
shape is retained; token containers and values are never traversed or printed.
