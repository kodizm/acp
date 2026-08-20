# CLAUDE.md

Kodizm runtime's ACP bridge. One canonical wire surface drives two CLI backends (Claude Code as primary, opencode as secondary); the orchestrator never branches on backend. The same `NewSessionRequest` / `PromptRequest` / `SessionUpdateEvent` shape carries every feature across both. `src/` is the architectural source of truth; verify there before trusting README or this file.

## Commands

| Command | Purpose |
|---------|---------|
| `bun test test/unit` | unit suite (mocked SDK) |
| `bun test test/e2e` | full ACP roundtrip, mocked SDK |
| `bun test test/integration` | real-API + real-CLI smokes; each suite gates on its own auth probe |
| `bun test path/to/file.ts -t 'pattern'` | single test by name pattern |
| `bunx tsc --noEmit` | typecheck (Bundler resolution, `@/` alias) |
| `bunx biome check --write src test` | lint + format with auto-fix |

## Architecture invariants

- One process per `KODIZM_BACKEND` value. Backend selection is spawn-time; not switchable mid-process.
- All backends implement `BackendDriver` (`src/backends/driver.ts`). Adding a new backend does not touch `AcpServer`; the dispatcher routes by interface contract only.
- `BackendDriver` methods include `compact`. Backends without a manual lever throw `MethodNotSupportedError`. Manual compaction sets `trigger:'manual'` on the matching `compaction_started` / `compaction_completed`; auto carries `'auto'`.
- `DriverCapabilities` flags advertised by every driver. Only `resume` (gates `session/load`) and `fork` (gates `session/fork`) are dispatch-gated; the rest are advisory. Authoritative list lives in `src/backends/driver.ts`.
- Kodizm canonical wire shape (`src/wire/`) is authoritative for orchestrator-facing fields (`systemPrompt`, `additionalDirectories`, `mcpServers`, `model`, `skills`, content blocks). Backends translate down. NEVER smuggle Kodizm fields through `_meta` on the orchestrator edge; `src/wire/schemas.ts` enforces this via `.refine()` at runtime.
- Opencode driver subscribes to opencode's `/event` SSE stream, dispatches `permission.asked` + `question.asked` through canonical `permission_request` + `question_request`, and replies via `sdk.permission.reply` / `sdk.question.reply`.
- `AcpServerLike`, `EmitLike`, `DEFERRED_SENTINEL`, `awaitPermissionResponse` live in `src/backends/claude/permission-bridge.ts` and are imported by the opencode driver + the bin. Cross-backend coupling is intentional today; a third backend's permission-bridge / ask-user-question must import from the claude file. Move it before extracting if you ever split per-backend packages.
- `permissionTimeoutMs` and `permissionDeferTimeoutMs` are mutually exclusive (schema `.refine()` rejects both set). Pick hard-deny on timeout OR soft-defer on timeout, not both.

## Bin scope

The published bin (`src/index.ts`) wires both backends: `bootBackend()` dispatches `KODIZM_BACKEND=claude` and `KODIZM_BACKEND=opencode` to real driver builders. A non-zero exit from that path is an import or construction failure, not a missing wire. This file and the README both claimed for months that only `claude` was wired, long after the branches landed, so trust `src/` over either.

## Opencode specifics

- Boot mode: `createOpencodeServer` from `@opencode-ai/sdk` (the SDK helper that spawns `opencode serve --port 0 --hostname 127.0.0.1` under the hood, waits for the listening marker, returns `{url, close}`). NOT the raw `opencode/server` Effect/Hono runtime. One server per Kodizm session; `bridge.stop()` is the canonical session terminator.
- Prompt path: v1 `sdk.session.prompt({sessionID, model: {providerID, modelID}, parts})`. The v2 `sdk.v2.session.prompt()` only queues a message, does NOT drive the LLM loop. Always use v1 for actual turns.
- SDK reply shapes are flat: `sdk.permission.reply({requestID, reply, message?})`, `sdk.question.reply({requestID, answers})`, `sdk.question.reject({requestID})`. NOT `{id, body: {...}}` (older draft).
- Canonical model wire is `<providerID>/<modelID>` slash-separated. Driver splits on first `/`.
- MCP tool naming: opencode uses `<sanitizedServer>_<tool>` (single underscore). Canonical wire uses `mcp__<server>__<tool>` (double underscore). Driver maps both directions via the per-session reverseMap.
- Tool lifecycle latches: opencode emits multiple `running` updates as the tool's input record fills in. Event-mapper has `toolBegan` / `toolEnded` `Set<callID>` so canonical `tool_call_begin` + `tool_call_end` each fire exactly once per call.
- Permission ruleset must be passed at `session.create({permission})`; opencode does NOT have a per-driver default mode. Driver wires `buildOpencodeRuleset(toolPolicy)` at newSession.
- Auth via `OPENCODE_AUTH_CONTENT` env, layered onto `process.env` only for the duration of `bridge.start()` then restored. No `~/.local/share/opencode/auth.json` mutation.
- Cross-process Pattern B is folded into `loadSession({sessionId, _meta.opencodeSessionId})`. No separate `hydrateSession` method; opencode's SQLite persistence survives process death.
- `ContextOverflowError` maps to `transport_error` (canonical SessionFailedReason has no `compaction_failure` code).
- **The SSE subscription MUST carry `directory`.** The v2 client builds `/event` with `directory` + `workspace` as query params (`v2/gen/sdk.gen.js`, `buildClientParams`), so `event.subscribe({})` scopes the stream to whatever the bin's own process cwd resolves to. Production sessions run in `/workspace/<repo>` while the bin is spawned elsewhere, so an unscoped subscription received only `server.connected` and `server.heartbeat` while every `message.part.updated` went to a scope nobody watched. Symptom: a session emits `model_advertisement` and nothing else, no error, and the turn is still billed. Only reproduces when the session cwd differs from the process cwd, which is why local tests using `process.cwd()` for both passed for months.
- **The turn ends on `session.idle`, not on a completed assistant message.** `isTurnComplete` keyed on the first `message.updated` carrying a completed assistant message; as soon as a turn calls a tool, that message IS the tool call and the reply comes in a later message. Symptom: `tool_call_begin` + `tool_call_end` + `usage` reach the orchestrator and `output_chunk` never does. `prompt()` races the loop against a 750 ms window after the RPC resolves, so a missing `session.idle` cannot hang it.
- **`usage` carries a per-message DELTA, not absolute figures.** opencode re-sends `message.updated` as it revises a message's tokens and cost, and a tool-using turn has several assistant messages. The orchestrator ADDS every `usage` event (StreamEventPersister rolls up, CostGuardMiddleware increments atomically), so absolute figures multiplied the accounting: four `usage` events for one turn, enough to trip `cost_limit` on a session well inside budget. The mapper keeps a `usageByMessage` snapshot and emits the difference.
- **Per-session servers are disposed on BOTH exit paths.** `closeSession` stops the bridge, but the orchestrator never sends `session/close`: it kills its `docker exec` client, stdin closes, `serve()` resolves and `main` returns with no signal. So disposal has to run at the end of `main()` as well as in the SIGTERM/SIGINT hook, through `BackendDriver.disposeAll?()` and `ShutdownOptions.disposeDriver`. Without both, every session leaked its `opencode serve`: six accumulated in one production container and filled its 1 GiB cgroup to 99.4 % with two OOM kills.
- These four were found in one session and each masked the next: the scope bug hid the truncation, the truncation hid the usage multiplication. When opencode goes quiet, check in that order.

## Lifecycle and failure handling

- `SessionUpdateEvent` is the canonical discriminated union (`src/wire/events.ts`). When adding a variant, extend the union AND wire mapping in every backend's `event-mapper.ts`.
- `shouldExitOnReason` (`src/util/exit-policy.ts`) decides whether a `session_failed` reason exits the container or keeps it alive (orchestrator may retry). Consult the file before adding a reason.
- Pattern B deferred permissions: when the driver receives a `deferredStore`, it persists locally; when not, it falls back to outbound RPCs `session/permission_deferred_persist` (write) and `session/permission_deferred_state` (read). Both paths must be supported.
- Claude bridge detects subagent spawn / complete inline from the Task tool: a `tool_use.name === 'Task'` triggers `subagent_spawn`; the matching `tool_result` is scanned for `agentId:` plus a `<usage>...</usage>` marker to fire `subagent_complete`. Token-split fields default to 0; `subagent_type` defaults to `'general-purpose'`. Lives in `src/backends/claude/event-mapper.ts`.

## Gotchas

- **Stdout is reserved for ACP frames.** A single `console.log` corrupts the JSON-RPC stream and kills the session. Use `createLogger` from `@/util/logger` (stderr-only) for structured logs, or `process.stderr.write` for raw.
- **Run `bun test` from the package directory, not from `kodizm.com` root.** Bun has a subprocess lifecycle quirk under `bun test` when invoked from a parent dir: spawned opencode subprocesses see stdout EOF immediately and exit with no output. `cd packages/kodizm-acp && bun test ...` runs everything green.
- `KODIZM_ACP_FORWARD_STDERR=1` enables an opt-in stderr pump on a spawned backend subprocess for hang / crash diagnosis.
- `KODIZM_DEBUG_RAW_SECRETS=1` disables allow-list redaction inside `DebugRecorder`. Incident-only; never set in production.
- Biome inlines short JSON arrays in config files (`package.json`, `biome.json`). My-coding's "always multi-line" rule applies to source code; accept biome's reformat for JSON.
- Path alias `@/` resolves to `src/` from `test/` only. Inside `src/`, use relative imports with `.ts` extension (`allowImportingTsExtensions: true` in tsconfig).
- Bun's `bun:test` is jest-compatible. Mocks via `mock(fn)` from `bun:test`. No `vitest`, no `jest`.
- `debug_log` carries one of the stage enums in `DebugStageSchema` (`src/wire/events.ts`). Read the schema before emitting a new stage value.
- Opencode subprocesses leak between failed test runs. `pkill -f "opencode serve"` between iterations is sometimes required during local development.
- `debug-recorder.test.ts` flakes occasionally under parallel test load; re-run is the workaround.
- Underscore-prefixed files in `test/integration/` are fixtures or manual scripts, NOT bun:test suites.

## Test layout

- `test/unit/` mirrors `src/` one-to-one and runs fully mocked.
- `test/e2e/` exercises the full ACP roundtrip with a mocked SDK.
- `test/integration/` holds smoke suites grouped by backend prefix (`claude-*`, `opencode-*`). Each suite probes its own auth at module load and skips cleanly when credentials are absent. Real-CLI suites need the matching binary on `PATH`.
- New tests reuse helpers from `test/integration/_helpers.ts` (claude) and `test/integration/_mcp-fixture.ts` (in-process MCP server).

## References

Upstream sources are git submodules under `references/`. Investigation order when a backend fact is uncertain: `src/` (this package) -> matching `references/<upstream>/` -> only then web. Submodules are pinned to specific SHAs; bumping is an explicit `git submodule update --remote` per ref.

| Path | Purpose |
|------|---------|
| `references/claude-code-cli-source-code/` | Claude Code CLI source. First stop for anything claude-driver related (SDK option shapes, tool dispatch, permission plugin). |
| `references/claude-agent-acp/` | Reference ACP agent implementation against Claude Code. Working example when wiring a new feature. |
| `references/cc-connect/` | Multi-CLI bridge that already speaks ACP. Prior-art for cross-backend coupling decisions. |
| `references/opencode/` | Opencode CLI source. First stop for opencode-driver questions (Question.Service, permission ruleset, MCP naming, /event SSE shape). |
| `references/typescript-sdk/` | ACP protocol TypeScript SDK source. Authoritative for `@agentclientprotocol/sdk` types and method names. |
