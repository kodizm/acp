# CLAUDE.md

Kodizm runtime's ACP bridge. One canonical wire surface drives three CLI backends (Claude Code, codex, opencode); the orchestrator never branches on backend. Same `NewSessionRequest` / `PromptRequest` / `SessionUpdateEvent` shape carries every feature across all three. `src/` is the architectural source of truth; verify there before trusting README or this file.

## Commands

| Command | Purpose |
|---------|---------|
| `bun test test/unit` | unit suite (mocked SDK + fake codex subprocess) |
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
- Codex driver collapses every codex-side approval / question / tool-call / token-refresh server request onto canonical channels (`permission_request`, `question_request`, `session/dynamic_tool_call`, `session/codex_chatgpt_token_refresh`). Pre-v2 snake_case aliases auto-translate. The full mapping lives in `src/backends/codex/driver.ts`.
- Opencode driver subscribes to opencode's `/event` SSE stream, dispatches `permission.asked` + `question.asked` through canonical `permission_request` + `question_request`, and replies via `sdk.permission.reply` / `sdk.question.reply`.
- `AcpServerLike`, `EmitLike`, `DEFERRED_SENTINEL`, `awaitPermissionResponse` live in `src/backends/claude/permission-bridge.ts` and are imported by codex + opencode drivers + the bin. Cross-backend coupling is intentional today; a fourth backend's permission-bridge / ask-user-question must import from the claude file. Move it before extracting if you ever split per-backend packages.
- `permissionTimeoutMs` and `permissionDeferTimeoutMs` are mutually exclusive (schema `.refine()` rejects both set). Pick hard-deny on timeout OR soft-defer on timeout, not both.

## Bin scope

The published bin (`src/index.ts`) only wires `KODIZM_BACKEND=claude`. `codex` and `opencode` are recognised by env but exit with code 2 and a "not yet wired" stderr line. For now, codex and opencode require programmatic embedding: import `CodexDriver` / `OpencodeDriver`, build the transport + `createAcpServer` manually. Anything in this file or README that talks about all three backends "working through the bin" is wrong until that wiring lands.

## Codex specifics

- Field shape is camelCase v2 (`threadId`, `turnId`, `itemId`, `approvalId`, `cwd`, `command`, `cachedInputTokens`, `tokenUsage.total.*`). Pre-v2 snake_case is auto-aliased in the approval pipeline.
- Item type discriminator is camelCase (`commandExecution`, `fileChange`, `mcpToolCall`, `contextCompaction`, `collabAgentToolCall`). Driver accepts both forms for forward + back compat.
- Reasoning chunks travel on dedicated methods (`item/reasoning/summaryTextDelta` + `item/reasoning/textDelta`), NOT via `subtype='reasoning'` on `agentMessage/delta`. Both routes feed canonical `thinking_chunk`.
- `codex app-server` has NO `--config <path>` flag. Inject `[mcp_servers.*]` etc. by setting `CODEX_HOME` to a temp dir + writing `config.toml` there. Per-key overrides go via `-c key=value`.
- ChatGPT-mode auth ignores `model` overrides and silently keeps the default model. API-key auth honors them.
- Some features only expose with explicit codex feature flags (`features.default_mode_request_user_input`, `features.request_permissions_tool`, `features.multi_agent_v2`). The latter is account-tier gated; chatgpt-mode never invokes `spawn_agent` organically regardless of plan tier.
- `hydrateSession({ sessionId, codexThreadId, codexJsonlPath, ... })` is the cross-process Pattern B entry. It is a public method on `CodexDriver`, NOT on `BackendDriver`.

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

## Lifecycle and failure handling

- `SessionUpdateEvent` is the canonical discriminated union (`src/wire/events.ts`). When adding a variant, extend the union AND wire mapping in every backend's `event-mapper.ts`.
- `shouldExitOnReason` (`src/util/exit-policy.ts`) decides whether a `session_failed` reason exits the container or keeps it alive (orchestrator may retry). Consult the file before adding a reason.
- Pattern B deferred permissions: when the driver receives a `deferredStore`, it persists locally; when not, it falls back to outbound RPCs `session/permission_deferred_persist` (write) and `session/permission_deferred_state` (read). Both paths must be supported.
- Claude bridge detects subagent spawn / complete inline from the Task tool: a `tool_use.name === 'Task'` triggers `subagent_spawn`; the matching `tool_result` is scanned for `agentId:` plus a `<usage>...</usage>` marker to fire `subagent_complete`. Token-split fields default to 0; `subagent_type` defaults to `'general-purpose'`. Lives in `src/backends/claude/event-mapper.ts`.

## Gotchas

- **Stdout is reserved for ACP frames.** A single `console.log` corrupts the JSON-RPC stream and kills the session. Use `createLogger` from `@/util/logger` (stderr-only) for structured logs, or `process.stderr.write` for raw.
- **Run `bun test` from the package directory, not from `kodizm.com` root.** Bun has a subprocess lifecycle quirk under `bun test` when invoked from a parent dir: spawned codex / opencode subprocesses see stdout EOF immediately and exit with no output. `cd packages/kodizm-acp && bun test ...` runs everything green.
- Bun-on-Bun (`bun run fakeBin.ts`) under `bun test` is unreliable; `BUN_TEST_*` env vars leak into the child and confuse Bun's nested runtime. The fake-codex fixture (`test/integration/_codex-fake-process.ts`) emits Node CJS scripts and uses `binaryPath: 'node'` to sidestep the issue entirely.
- `Bun.spawn({ env })` LAYERS env onto `process.env` by default. Pass `replaceEnv: true` (custom `CodexAppServerSpawnOptions` flag) when the test needs a fully-scrubbed environment.
- `KODIZM_ACP_FORWARD_STDERR=1` enables an opt-in stderr pump on the codex subprocess for hang / crash diagnosis.
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
- `test/integration/` holds smoke suites grouped by backend prefix (`claude-*`, `codex-*`, `opencode-*`). Each suite probes its own auth at module load and skips cleanly when credentials are absent. Real-CLI suites need the matching binary on `PATH`.
- New tests reuse helpers from `test/integration/_helpers.ts` (claude), `test/integration/_codex-fake-process.ts` (deterministic codex), `test/integration/_mcp-fixture.ts` (in-process MCP server).
