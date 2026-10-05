# Hoplite MCP: official server and toolkit transport

Reviewed 2026-10-05 against the official
[MCP server guide](https://hoplite.sh/docs/cli/mcp-server) and
[CLI configuration](https://hoplite.sh/docs/cli/configuration).

## Two different directions

The hosted server lets another agent/client **drive Hoplite** over Streamable
HTTP at `https://api.hoplite.sh/mcp`. Giving Hoplite agents access to your own
MCP tools is a different integration, documented under
[agent MCP servers](https://hoplite.sh/docs/agent/mcp).
The official CLI can also explicitly bridge loopback MCP servers on the user's
machine; see [local-tool opt-in](official-cli.md#opt-in-tools-on-your-machine).
That is not the hosted Hoplite MCP endpoint or this toolkit's OAuth transport.

Discovery metadata is published at
`https://api.hoplite.sh/.well-known/mcp.json`, also mirrored on `hoplite.sh`.
OAuth protected-resource metadata is at
`https://api.hoplite.sh/.well-known/oauth-protected-resource/mcp`.
Discovery advertises capabilities; it is not authentication or permission to act.

## Authentication choices

| Client | Recommended configuration | Boundary |
| --- | --- | --- |
| Interactive external MCP client | OAuth browser sign-in and workspace selection | Acts as the signed-in user |
| Headless external MCP client | API key or project-restricted service-account key | Key permissions and project scope still apply; user-only routes require OAuth |
| This toolkit's default MCP transport | OAuth file created by `hoplite mcp start` | Does not currently use `HOPLITE_API_KEY` for MCP requests |
| This toolkit's direct API transport | Explicit key plus `--transport api` | Documented dedicated-command subset, not general MCP access |

For an OAuth-capable client, the official Claude Code setup is:

```bash
claude mcp add --transport http hoplite https://api.hoplite.sh/mcp
```

The client handles browser authorization. For the toolkit's separate local
OAuth file, run:

```bash
hoplite mcp start
bun run hoplite-toolkit -- auth
bun run hoplite-toolkit -- projects
```

The OAuth file defaults to `~/.config/hoplite/mcp-oauth.json`; `XDG_CONFIG_HOME`
or toolkit `HOPLITE_OAUTH_PATH` can change the location. Keep it private.
Toolkit `auth` checks shape, expiry, and permissions without refreshing or
contacting the server. An actual MCP connection attempts refresh when needed;
a local check alone does not prove that refresh or remote authorization works.
Do not assume an arbitrary MCP client's token store is shared with the toolkit.

For a client that supports runtime environment expansion, this configuration
contains a placeholder, not a real key:

```json
{
  "mcpServers": {
    "hoplite": {
      "type": "http",
      "url": "https://api.hoplite.sh/mcp",
      "headers": {
        "Authorization": "Bearer ${HOPLITE_API_KEY}"
      }
    }
  }
}
```

Upstream documents this expansion for Claude Code's `.mcp.json`; do not assume
other clients expand it. Use their secret-injection mechanism instead of
committing literal keys. The server also accepts `X-Api-Key`. API keys fix the
workspace; service-account project restrictions remain enforced. Use the least
permissions needed. A `401` means invalid/revoked/expired credentials; `403`
can mean missing permission, scope, or a user-only route needing OAuth.

Official `hoplite mcp config` prints client configuration, and
`--format claude` prints a Claude Code setup command. Avoid `--inline-key`:
it deliberately embeds a resolved credential in output. Do not upload generated
secret-bearing configs, paste them into chat, or use them as test fixtures.

## What the server exposes versus what we wrap

The official server documents `hoplite_list_projects`, `hoplite_list_threads`,
`hoplite_get_thread`, `hoplite_create_thread`, and `hoplite_call_api`.
`hoplite_create_thread` starts an agent run; it is not a read. The server accepts
`model` or the backward-compatible `modelId` alias, which must agree if both
are supplied. Discover models rather than hardcoding the documentation's examples.

`hoplite_call_api` supports a much broader reviewed read/write surface than
this toolkit. Use `bun run hoplite-toolkit -- tools` for live tool-schema
discovery when authorized; normal tests never do so. This toolkit only exposes
its dedicated guarded actions; its separate generic `api` command is direct
REST and GET/HEAD-only. Toolkit allowlists and confirmation flags are **not**
enforced by other MCP clients or the hosted server on our behalf.

Important upstream details:

- Each `hoplite_call_api` response body is capped at **1 MiB**. On
  `api_response_too_large`, request a smaller page where supported; direct REST
  is a separate option, not an automatic retry or size-limit bypass in our CLI.
  Our direct transport independently caps responses at **2 MiB**.
- Existing credential retrieval/rotation, terminal sessions, browser controls,
  binary attachment transfer, and raw workspace logs are not exposed by this
  MCP server. Creation/staging responses can still contain one-time secrets or
  signed upload URLs; do not assume all output is safe to publish.
- The MCP guide describes an optional stop `runId`; the reviewed REST schema
  requires it, and **our toolkit always requires the exact run ID**. Never drop
  that guard to imitate a more permissive upstream example.
- The MCP prose uses `/api/github/...` discovery examples, while the current
  OpenAPI and this toolkit use `/api/source-control/github/...`. Keep our pinned
  routes; do not infer alias support or change paths from prose alone.

See [API support](api.md) and [route classification](compatibility.md) for the
toolkit's narrower contract and authorization rules.
