# Changelog

All notable changes to `@kodizm/acp` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.1] - 2026-11-06

### Added

- **`ctl start --features PATH`.** A 0600 hand-off file holding the canonical
  `features` object (the wire field SDK sessions already carry). The daemon
  translates it with the same function the SDK driver uses and starts the pane
  with `--tools` (the built-in set), `--disallowedTools` (bare names, which the
  CLI removes from the model's context) and the matching `CLAUDE_CODE_DISABLE_*`
  env. A pane without the flag offers the whole tool set, as before. Content
  that is not a features object, `simple: true` (the base settings deny both
  web tools it would leave), an empty or non-identifier tool name, or a file
  that is not private is a `usage_error` and starts no pane; an unknown key
  is ignored, as on the SDK path. Measured on
  CLI 2.1.318 with a bare prompt: 22.9k prompt tokens by default, 8.8k with
  `--tools Bash,Read`, 18.0k with every family disallowed.

### Fixed

- **`usage_limit` covers the out-of-extra-usage sentence.** The CLI renders
  "You're out of extra usage · resets <time>" when the overage credit is spent
  too; it stayed `rate_limit` and the turn waited instead of closing.

## [0.9.0] - 2026-11-04

### Added

- **`kodizm-acp tmuxd` start contract v2.** `ctl start` takes the value flags
  `--mcp-config`, `--tool-policy`, `--system-prompt-file`, `--permission-mode`,
  `--one-shot`, `--deadline-seconds` and `--retain-failed-seconds`. An unknown
  start flag is a `usage_error`. Every ctl reply carries `daemon_version`
  (read from `package.json`). The hand-off files are cleaned up after a refused
  or failed start. A `dontAsk` pane denies without calling the ingest. First-run
  seeding is part of the start.
- **Unattended pane lifecycle.** A `--one-shot` pane closes once its turn
  event (`turn_completed` or `turn_failed`) was delivered.
  `--retain-failed-seconds n` delays the close of a failed pane by n seconds
  (default 0) and makes a pane without `--one-shot` close after a failed turn;
  while retained the pane takes no prompt (`busy`), sends no heartbeat and
  ignores an ingest 410. `--deadline-seconds` fails a turn that runs past it
  with reason `deadline` and interrupts the pane. A pane started without these
  flags behaves as 0.8.2.
- **`usage_limit` is told apart from `rate_limit`.** The transcript API error
  is classified as `usage_limit` only when the entry is an API error message
  with the `rate_limit` error and a limit-resets text; every other 429 stays
  `rate_limit`, and an `authentication_failed` StopFailure stays `auth_error`.
- **`turn_completed` carries `lastAssistantMessage`**, always a string, and the
  same text is kept in `last-assistant-message.txt` in the pane's settings
  directory.
- The per-pane settings file sets `autoContinueAtUsageLimit` to off, so the CLI
  does not resume on its own after a usage limit.
- An optional daemon idle timeout, set with
  `KODIZM_TMUXD_IDLE_TIMEOUT_SECONDS` (`session_ended` reason `idle_timeout`).

### Changed

- The permission RPC helpers (`AcpServerLike`, `EmitLike`, `DEFERRED_SENTINEL`,
  `awaitPermissionResponse`) moved to `src/backends/permission-rpc.ts`, shared
  by both backends. No behaviour change.
- A turn the CLI ends on a transcript API error is now reported as
  `turn_failed` with the classified reason (`usage_limit`, `rate_limit`,
  `auth_error` or `api_error`) instead of `turn_completed`, whether the Stop
  hook or the watchdog closes it. A usage limit fails the turn at once; a later
  assistant or user record in the same turn means the CLI recovered and clears
  the error.

### Fixed

- A first-run seeding race on a shared `HOME`.
- A pane slot TOCTOU between the capacity guard and the registration.
- Hand-off file cleanup stopped at the first failed unlink.

## [0.8.2] - 2026-11-04

### Fixed

- **A main-checkout Live pane could not edit.** The pane loaded the user settings
  file (`--setting-sources user`), whose clone guards deny `Edit` on
  `/workspace/.default` and `/workspace/.repos`, so a pane started on the main
  checkout had every Edit and Write refused. The pane now passes an empty
  `--setting-sources`: it loads its own `--settings` file alone (which carries
  everything else the user file holds), and the repository's settings stay out
  as before. Verified on CLI 2.1.280: an empty list drops a user-scope deny and
  keeps the `--settings` allow.

## [0.8.1] - 2026-11-04

### Fixed

- **tmuxd permission open is retried.** A permission dialog is opened once, so
  a network error, a timeout, a 429 or a 5xx on `POST .../permissions` left it
  open in the pane with no row for any door to answer. The open is now retried
  with the event queue's backoff for 90 s; any other refusal is final.
- **tmuxd stops retrying a stream the ingest will never take.** A 410
  `session_closed` and a 422 ended up retried for ever (a 422 wedged the queue,
  since a skipped batch is a sequence gap). Both now end the stream and close
  the pane, like a stale gen. A 410 `expired_token` and a 401 stay retries: the
  next `rotate-token` cures them.
- **Bare GitHub tokens are redacted** (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`
  and `github_pat_` shapes), not only the `x-access-token:` URL form.
- Lint is clean again: non-null assertions in the opencode mapper and permission
  bridge, and `delete`, `console` in the integration smokes.

## [0.8.0] - 2026-11-04

### Added

- **`kodizm-acp tmuxd`**: the Live session runtime. It keeps the real
  interactive Claude Code CLI in a tmux pane inside the project container and
  streams its hook and transcript events to Kodizm over a signed HTTP ingest,
  instead of running a turn through the SDK. `tmuxd ctl <verb>` (start,
  prompt, command, cancel, stop, rotate-token, status) is the command surface
  for Laravel, `tmuxd hook <Event>` is the helper the per-pane settings file
  runs, and `tmuxd daemon` owns the panes. The ACP server and both backends
  are unchanged; `tmuxd` has its own entry point and writes one JSON line to
  stdout.
- Prompt text is sanitised (control bytes stripped, a first `!` or `/`
  refused) and delivered by paste; slash commands go through a separate
  allowlist. Events are redacted before they leave the container, and a
  PermissionRequest hook answers only on an explicit decision.
- The paste flags follow the installed tmux: `paste-buffer -S` exists only from
  tmux 3.7, so older tmux (Debian 13 ships 3.5a) gets the call without it.

## [0.7.0] - 2026-11-03

Entries for 0.5.5 to 0.6.9 were not kept in this file; `git log v0.5.4..v0.6.9` has them.

### Added

- **`plugins` on `session/new` and `session/load`**. An array of absolute
  directories the Claude backend hands to the SDK as
  `plugins: [{ type: 'local', path }]`, so the CLI loads a plugin (for
  example the baked ac-lsp language servers) for that query only. Every path
  must sit under `/opt/kodizm/plugins/` and contain no `..` segment; the
  field is also banned inside `_meta`. The opencode backend ignores it. A
  bridge older than 0.7.0 strips the field silently.
- `config.claudeAgentSdk` in `package.json`: the exact SDK version this
  release is built against. The agent image installs the CLI from the
  matching platform package, so the one `claude` binary equals the SDK's
  bundled CLI.

### Changed

- `@anthropic-ai/claude-agent-sdk` is pinned to `0.3.280` instead of
  `^0.3.280`, and every bundled dependency moved to `devDependencies`: the
  published `dist/index.js` imports only Node built-ins, so the package now
  installs with no runtime dependencies.
- The package description and keywords no longer mention codex, which the
  bin has not wired since it was retired.

## [0.5.4] - 2026-05-08

### Added

- **Task tool subagent lifecycle events on the Claude bridge**.
  `claude/event-mapper.ts` now detects `tool_use.name === 'Task'`
  (and the legacy `'Agent'` alias) on assistant messages and emits
  `subagent_spawn` before the generic `tool_call_begin`. The matching
  `tool_result` is scanned for the Task tool's wire markers
  (`agentId:` line + `<usage>total_tokens: N ...</usage>` block);
  when both land, `subagent_complete` fires before the generic
  `tool_call_end` with the parsed `total_tokens` mapped to
  `inputTokens` (the Task tool wire does not split input vs output
  so `outputTokens / cacheReadTokens / cacheCreationTokens / costUsd`
  default to 0).
- `extractSubagentType()` helper reads the optional `subagent_type`
  field on the Task tool input and stamps it as the spawn event's
  `model` field; defaults to `'general-purpose'` (the SDK's own
  default) when missing.

### Why

Claude Code's Task tool does NOT spawn a separate SDK session; it
inlines the subagent's output as a `tool_use` / `tool_result` pair
inside the parent conversation. Prior versions only fired
`subagent_spawn` when the SDK emitted a system init with
`parent_tool_use_id`, so Task tool delegations stayed invisible on
the orchestrator's subagent tree view. The new mapper branch closes
the gap so the Filament Subagents tab populates automatically for
every Task tool call.

## [0.5.3] - 2026-05-08

### Added

- **`session/compact` JSON-RPC**. New canonical wire RPC mapped per backend onto a manual context-compaction lever. The matching `compaction_started` + `compaction_completed` `sessionUpdate` events both carry `trigger: 'manual'` when compact() drove the compaction (the existing per-backend default tag is still `'auto'`). Schema: `{ jsonrpc: '2.0', id, method: 'session/compact', params: { sessionId: string } }`. Response is an empty object.
- **Claude driver `compact()`**: dispatches the SDK's `/compact` slash command as a synthetic prompt turn through the existing `prompt()` pipeline. Sets a per-session `pendingManualCompact` latch the event-mapper consults to override the started event's trigger ('manual' instead of the default 'auto' the SDK's `system status: compacting` carries).
- **Codex driver `compact()`**: dispatches `thread/compact/start` against the codex subprocess with a per-call `CodexEventMapper` that re-tags the `ContextCompaction` item lifecycle with `trigger: 'manual'`. Awaits the matching `compaction_completed` event before resolving (10s timeout guard).
- **Opencode driver `compact()`**: dispatches `sdk.session.summarize({sessionID, providerID, modelID, auto: false})` with a `pendingManualCompact` latch the OpencodeEventMapper consults via `applyManualCompactLatch` so the persistent SSE-driven `session.compacted` event re-tags `trigger: 'manual'`. Captures `providerID + modelID` at session.create time.

### Changed

- `BackendDriver.compact(request, emit)` is now a required method on every driver. Existing drivers gained the impl; custom drivers MUST add `compact()`. The `emit` parameter exists so compaction events flow through the same `sessionUpdate` notification fan-out as `prompt()` turns.

### Migration notes

- Orchestrator-side: bump `@kodizm/acp` to `0.5.3` and the matching Docker image tag.
- No wire-breaking changes for clients that do NOT call `session/compact`. Clients that try the new RPC against an older driver get `MethodNotSupportedError` with `code: -32601` and a `supportedMethods` list in `data`.

## [0.5.2] - prior

Phase 4 + 5 deferred follow-ups (subagent threading, debug stream, failure heartbeat); see `.ac/plans/acp-failure-heartbeat-debug-stream/` for the corresponding plan.
