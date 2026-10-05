# Official Hoplite ACP

Reviewed against the public documentation on **2026-10-05**. This guide covers
the **official** Hoplite CLI and endpoint, not an implementation in this
unofficial toolkit. The toolkit does not implement ACP or relay editor sessions.
Its mutation allowlist, `--confirm`, and exact-run stop guards do not govern
official ACP clients; those clients must enforce their own user authorization.

## Local editor bridge

Use the official `hoplite acp` for an editor that launches a local ACP process.
It speaks JSON-RPC on stdin/stdout and relays to Hoplite; diagnostics use stderr.
Official agent commands, including `acp`, are available on **macOS and Linux
only**, not the Windows CLI. This is not `bun run hoplite-toolkit -- acp`.

For example, merge this into Zed's `settings.json`:

```json
{
  "agent_servers": {
    "Hoplite": {
      "type": "custom",
      "command": "hoplite",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Ensure the official executable is on the editor's `PATH`, or use its absolute
path. Each session uses the project linked to the repository at its `cwd`.
`--project <project-id>` or `HOPLITE_PROJECT_ID` pins all sessions to one project.
Paseo 0.9 requires this stdio bridge, not a direct WebSocket connection; its
home-directory provider check can report `No Hoplite project` unless pinned.

The bridge shares the official CLI's stored keys and opens browser sign-in when
needed; the editor needs no token. CLI 2.x keys can require a fresh sign-in.
macOS uses Keychain when available; fallback credential files have owner-only
`0600` permissions. Do not copy keys into editor settings or this repository.
Setting both `HOPLITE_ACP_URL` and `HOPLITE_ACP_API_KEY` bypasses browser sign-in;
inject secrets securely rather than embedding them in configuration examples.

## Remote transports and authentication

The current documented endpoints are:

| Transport | Endpoint | Message delivery |
| --- | --- | --- |
| Streamable HTTP | `https://api.hoplite.sh/acp` | JSON-RPC requests plus SSE |
| WebSocket | `wss://api.hoplite.sh/acp` | JSON-RPC text frames |

Both use **`/acp`**. The current source does not document an `/acp/ws` route.
Select the project with `?projectId=<project-id>` when creating a session.

For HTTP, retain `Acp-Connection-Id` from initialization and send it on later
`POST`, `GET`, and `DELETE` requests. Open a `GET` with
`Accept: text/event-stream`; session streams also use `Acp-Session-Id`.
Connected `POST` requests return `202 Accepted`: their JSON-RPC responses and
`session/update` notifications arrive through SSE, not a completed-run response
body. Release the connection with `DELETE /acp`. WebSocket initialization
returns the connection ID in the upgrade response; close the socket when done.

Authenticate every HTTP request or WebSocket upgrade with OAuth
`Authorization: Bearer <access-token>`, or a workspace API key in `X-Api-Key`
or `Authorization: Bearer <api-key>`. Discover OAuth metadata at:

- `https://api.hoplite.sh/.well-known/oauth-protected-resource/acp`
- `https://api.hoplite.sh/.well-known/oauth-authorization-server/api/auth`

OAuth scopes are `project:read`, `thread:create`, `thread:read`, and
`thread:update`, according to the operations needed. The API-key instructions
call for project read and thread create/read/update/**stop** permissions.
Do not assume a key that lists threads can prompt or stop them.

Transport credentials alone are not protocol login. Initialize with a non-null
request ID, then use the advertised authentication method with v1
`authenticate` or v2 `auth/login`; API keys use `hoplite-api-key`.
Keep credentials out of JSON-RPC bodies except the documented OAuth
`_hoplite/auth/refresh` request. HTTP refresh uses a new token on the next
request; WebSocket refresh uses that advertised extension. The replacement must
belong to the same user and OAuth session. Refresh before the one-hour access
token expiry; an open stream is not a permanent authorization grant.

## Durable sessions, replay, and reconnects

`session/new` allocates a server-generated session ID; the first
`session/prompt` creates the thread **with that same ID** and starts work.
Later prompts append to that durable thread. Save the exact session ID rather
than creating another session after a timeout. Loading a teammate's thread is
allowed within the authorized workspace/project; prompting it joins you as a
participant. Viewing a shared thread is not authorization to act for its author.

On a fresh authenticated connection, use v1 `session/load` or v2
`session/resume` with the saved ID. A disconnected prompt **continues running**;
do not resend it just because its response was lost. v1 supports a stable
`_meta.hoplite.clientMessageId` for deduplicating a repeated prompt by the same
member in the same thread; preserve it if deliberately reconciling a delivery.

For v1, follow the documented recovery sequence:

1. Load with `_meta.hoplite.replayLimit` when advertised; `1` keeps recovery
   replay short. Without a limit, loading replays every message.
2. Inspect `_meta.hoplite.activeRun`. If `null`, use `lastRun.status`:
   `completed` → `end_turn`, `cancelled` → `cancelled`, `failed` → `refusal`.
   Missing fields are not evidence of success; older servers may require
   waiting for `_hoplite/run_status`, and unreadable run data can be omitted.
3. When following an active run, omit text already displayed and upsert tool
   calls by `toolCallId`: activity is replayed from the run's start.
4. Keep the session stream open after a prompt completes to receive shared
   thread activity. v2 does **not** yet receive these live updates.

Paged v1 history uses `_hoplite/session/history` and the returned cursor when
advertised. Do not assume an undocumented `Last-Event-ID` replay contract.
The official local bridge reconnects and deduplicates running-prompt activity
itself, then resolves the prompt with its run's stop reason.

## Cancellation, approvals, and local access

- Disconnecting is not cancelling. The thread-actions section specifies that
  `session/cancel` stops this client's prompt's run; the separate
  `_hoplite/thread/stop` extension can stop the active run whoever started it.
  Treat thread-wide stop as a distinct, explicitly authorized action.
- Cancellation does not generally clear queued prompts: they can run next.
  A first prompt still queued behind another run is the documented exception:
  cancelling it removes its message. Do not promise that Stop makes a thread idle.
- Show `session/request_permission` to the user; never silently approve it.
  Remove the prompt on `$/cancel_request` when another client decides or the
  run ends. Teammates' runs do not send you their approvals; their author decides.
- Project MCP configuration is separate from client MCP configuration. The
  remote endpoint rejects client-provided `mcpServers`; the local bridge drops
  them with a stderr notice. The advertised `_hoplite/client_tools/*`
  extensions are a separate opt-in path for tools on the user's machine.
- Enforce read-only tool restrictions locally, and reject tools not offered.
  `trusted` skips approvals; `approve_server` permits the server for the rest
  of the connection. Local-tool approvals belong only to the registering
  connection; the normal HTTP approval endpoint refuses them with `409`.
- Local commands need user opt-in and local enforcement of the exact approved
  command and resolved working directory. Their permission choices allow one
  call, not blanket access. Do not interpret a remote file diff as permission
  to edit the user's local checkout; generic client filesystem RPC support is
  not specified by this Hoplite page.
- Diffs and tool output are bounded/redacted, not proof that all content is
  safe to publish. Credential-file diffs can be omitted and edits can be partial.
  A failed tool is not sufficient evidence that nothing changed.

## Current limits and compatibility

- Stable ACP v1 and experimental v2 share the endpoint; negotiate the version
  and advertised capabilities, not an assumed feature set for every client.
  v2 may change incompatibly; its prompt response is acceptance, while the final
  `idle` state update supplies the stop reason.
- Text, resource links, and embedded text resources are supported; embedded text
  is stored as an attachment. Images, audio, and embedded binary resources are
  rejected. Request bodies/WebSocket messages are capped at 1 MiB; HTTP rejects
  oversize input with `413`, while WebSocket closes with code `1009`.
- A connection follows at most eight sessions live; an idle session can lose
  live updates at the limit and must be loaded again. Connection limits can
  return `429` with `Retry-After: 60`. Closed/expired connections return `404`:
  initialize and load/resume again. HTTP connections have a 24-hour lifetime;
  unused connections expire after 30 minutes. Explicitly close unused clients.

## Sources

- [Official ACP guide](https://hoplite.sh/docs/cli/acp): transports, authentication,
  sessions, streaming, approvals, local tools, limits, and protocol status.
- [Official CLI guide](https://hoplite.sh/docs/cli): platform support and credentials.
- [Toolkit scope](../README.md), [compatibility boundaries](compatibility.md), and
  [bundled skill](../skills/hoplite-cli/SKILL.md): ACP belongs to the official CLI.
