# Working alongside the official CLI

Reviewed 2026-10-05 against the official [CLI](https://hoplite.sh/docs/cli),
[configuration](https://hoplite.sh/docs/cli/configuration), and
[`ask`](https://hoplite.sh/docs/cli/ask) documentation, plus the
[interactive local-tool sections](https://hoplite.sh/docs/cli/interactive).
This guide describes
upstream behavior, not features implemented by the toolkit.

## Install and upgrade

Install the official package separately from this repository:

```bash
npm i -g @usehoplite/cli
hoplite --version
```

On macOS, Homebrew is also supported: `brew install CarbonCopyInc/tap/hoplite`.
Use the same installer to upgrade: `npm i -g @usehoplite/cli@latest` or
`brew upgrade hoplite`. The official CLI checks for updates but does not install
them automatically. Native releases include checksums and a `hoplite-legacy`
helper; follow the upstream download instructions and keep the binaries together.

The interactive agent, `ask`, `exec`, `shell`, `push`, `status`, and local `acp`
are currently macOS/Linux features. Windows supports sign-in, imports, handoff,
skills, and MCP commands. This is the official CLI's platform matrix, not a
claim that this Bun toolkit has been tested on every platform.

## Pick the right command

| Need | Official CLI | Toolkit |
| --- | --- | --- |
| Interactive coding and approvals | `hoplite`, `hoplite --resume ID` | Not implemented |
| One request with run completion | `hoplite ask --json PROMPT` | Writes return acceptance, not a completed agent answer |
| Remote shell or command | `hoplite shell`, `hoplite exec COMMAND` | Not implemented |
| Send local uncommitted changes | `hoplite push` | Not implemented |
| Editor agent integration | `hoplite acp`; see [ACP](acp.md) | Not implemented |
| Import or hand off local history | `onboard`, `update`, `undo`, `handoff` | Not implemented |
| Local configuration status | `hoplite status --json` | Toolkit `status` instead scans tasks over MCP |
| Bounded operational reads/actions | Use the upstream interfaces | `bun run hoplite-toolkit -- ...` |

`hoplite` means the installed official binary. `bun run hoplite-toolkit -- ...`
means this repository; the older `bun run hoplite -- ...` alias still works.
The toolkit's allowlist and `--confirm` guards do **not** wrap official commands,
ACP, or a separately configured MCP client. Prompts can start paid runs and
change remote code; shell, push, import, and handoff commands also have side effects.

## Sign-in and project selection

Run `hoplite login` interactively before scripted agent sessions. Run from a
repository linked to a Hoplite project; upstream resolves its GitHub remote.
Use `/project` or `HOPLITE_PROJECT_ID` when that selection is ambiguous.
`hoplite login --org SLUG` selects another workspace. Do not assume this project's
`HOPLITE_ORG_ID` or mutation allowlist controls the official session selection.

Official sessions (`hoplite`, `ask`, `acp`, `exec`, `shell`) normally use stored
credentials, not just `HOPLITE_API_KEY`; the [ACP guide](acp.md) documents its
explicit endpoint/key override. Legacy/import commands and `mcp config` accept an
explicit key. When intentionally provisioning a stored key, upstream supports
`hoplite auth login --api-key-stdin`; never paste a key into command arguments,
logs, or committed config. `hoplite auth status` describes the selected key and
workspace. Toolkit `auth` and `api-auth` only inspect their local configuration.

The official CLI stores keys in macOS Keychain where available; elsewhere it
uses an owner-only credentials file. `XDG_CONFIG_HOME` relocates the credential
and MCP OAuth files, but not `~/.hoplite` session settings. Toolkit API transport
does not automatically read the official credential store. Toolkit MCP OAuth
comes from `hoplite mcp start`, a separate flow from agent-session sign-in.

`hoplite logout` revokes/removes all stored CLI keys for the selected API, not
just a single terminal session. Review its scope before using it on a shared
machine. API keys that cannot be revoked remotely may remain valid after local
removal; follow upstream's warning rather than assuming deletion revoked them.

## Scripted requests

`hoplite ask` starts a new thread unless given `--resume`; use an exact
`--resume=ID` when target ambiguity is unacceptable. `--resume` without an ID
selects the latest thread for the repository.

- `--json` emits one result object containing the thread ID when one was created,
  assistant output, and run outcome. It is not the toolkit's API receipt format.
- Exit statuses: `0` success, `1` failure, `130` SIGINT, `143` SIGTERM. On either
  signal, upstream stops the run and prints no result, even with `--json`.
- Pending approvals/questions require the app or an interactive resumed session;
  `ask` cannot answer them itself. Do not automatically grant approvals to unblock CI.
- A missing/obsolete stored sign-in fails non-interactively; it cannot complete
  browser login in CI. Unlike the interactive session, `ask` does not retry a
  failed connection in the background.
- Arguments supply the prompt. With no prompt arguments, stdin becomes the
  prompt; with arguments, stdin becomes an attachment. Use `</dev/null` when a
  script must not accidentally upload its input. Do not send secrets or bypass
  credential-file checks with `--allow-credentials` as a routine workaround.

Even a successful run is not independent evidence of tests, merge, or deployment.
Inspect the actual verification output. Keep production publishing separately
authorized.

## Opt-in tools on your machine

Cloud agent execution does not mean every operation stays in the sandbox.
The current [interactive guide](https://hoplite.sh/docs/cli/interactive) also
documents local bridges that this toolkit does not implement:

- `--mcp NAME=URL` offers a local Streamable HTTP server over loopback only;
  stdio servers are not supported. Up to eight servers can be configured.
  The CLI exposes tools marked `readOnlyHint: true` by default. Adding `write`
  exposes mutating tools; it does not itself approve calls. Each call needs
  approval from the registering CLI unless explicitly configured with `trust`.
  `ask` cannot display those approval cards, so upstream requires `trust` for
  this use. Do not add it merely to make an unattended command work.
- `--local-exec` additionally requires the workspace's local-command capability
  to be enabled. Personal settings can opt in; repository `.hoplite.json`
  cannot. Local approval covers the command and working directory. Narrow rules
  or eligible session approvals can authorize later simple commands; `ask`
  runs them only when an existing rule permits them. Keep this disabled unless
  the task explicitly needs the user's machine.

Only the CLI that registered local tools can approve their calls; the web app
or another session cannot. CLI local command execution inherits the local
environment except the two documented Hoplite API-key variables; other secrets
may still be accessible. Tool arguments/results and command/output are saved
in the thread. Treat these bridges as deliberate local access and data sharing,
not as a cloud-sandbox security boundary. See [ACP](acp.md) for custom-client
enforcement and the difference between its extensions and CLI conveniences.

## Upgrading from 2.x

Bare `hoplite` now starts an agent; use `hoplite onboard` for history import.
Use `hoplite --version`, not `hoplite version`. Reauthenticate after upgrading:
older stored keys can still work for legacy commands but lack agent-session
permissions. Do not extract or rewrite credential files to work around this.
