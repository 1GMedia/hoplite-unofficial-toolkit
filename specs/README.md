# Public OpenAPI inputs

These are unauthenticated public documentation snapshots retrieved on 2026-10-09:

- `direct-openapi.json`: https://hoplite.sh/docs/openapi.json
- `platform-openapi.json`: https://hoplite.sh/docs/platform-openapi.json

They contain upstream public examples, not tenant data. Do not replace them with
authenticated responses. Generation never downloads specs or follows remote refs.

Refresh is manual: review new public specs, replace these inputs, run
`bun run operations:generate`, inspect the generated diff, then run
`bun run operations:check`, tests, typecheck, and build. Review pinned-contract
drift separately; regeneration never rewrites `docs/api-contract.json`.

The Platform snapshot uses schema-local `#/definitions/...` refs. Generation
hoists those definitions into uniquely named components in memory. Upstream
recursive JSON-value schemas become an equivalent recursive `JsonValue` type,
avoiding TypeScript's circular indexed-property limitation. Original snapshots
are not modified by either adaptation. The adaptation is deliberately narrow;
other invalid references fail rather than fetching or inventing schemas.
