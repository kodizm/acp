# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Mission

Kodizm runtime's ACP bridge. One canonical wire surface drives three CLI backends (Claude Code, codex, opencode); the orchestrator never branches on backend. Same `NewSessionRequest` / `PromptRequest` / `SessionUpdateEvent` shape carries every feature across all three. `src/` is the architectural source of truth; README is being repurposed into a purpose / install / features doc.

## Commands

| Command | Purpose |
|---------|---------|
| `bun test test/unit` | unit suite (mocked SDK + fake codex subprocess) |
| `bun test test/e2e` | full ACP roundtrip, mocked SDK |
| `bun test test/integration` | real-API smoke (Claude SDK + real codex CLI + real opencode CLI) |
| `bun test test/integration/codex-features-final.smoke.test.ts` | fake-fixture deterministic codex coverage (17 tests) |
| `bun test test/integration/opencode-features.smoke.test.ts` | real-LLM opencode F1-F6 against `opencode-go/deepseek-v4-flash` (~$0.05/run) |
| `bun test path/to/file.ts -t 'pattern'` | single test by name pattern |
| `bunx tsc --noEmit` | typecheck (Bundler resolution, `@/` alias) |
| `bunx biome check --write src test` | lint + format with auto-fix |

## Architecture invariants

- One process per `KODIZM_BACKEND` value. Backend selection is spawn-time; not switchable mid-process.
- All backends implement `BackendDriver` (`src/backends/driver.ts`). Adding a new backend does not touch `AcpServer`; the dispatcher routes by interface contract only.
- Required `BackendDriver` methods: `capabilities`, `initialize`, `newSession`, `prompt`, `cancel`, `loadSession`, `forkSession`, `compact`. Capability gating only applies to `loadSession` (gated on `resume`) and `forkSession` (gated on `fork`); the other six flags (`fileUpload`, `thinking`, `subagent`, `skillEvents`, `debug`, `askQuestion`) are advisory and not enforced at the wire boundary.
- `compact()` is mandatory (since 0.5.3). Backends without a manual lever throw `MethodNotSupportedError`. Manual compaction sets `trigger:'manual'` on `compaction_started` / `compaction_completed`; auto carries `'auto'`.
- `DriverCapabilities` carries 8 flags: `resume`, `fork`, `fileUpload`, `thinking`, `subagent`, `skillEvents`, `debug`, `askQuestion`. Every driver fills all 8.
- Kodizm canonical wire shape (`src/wire/`) is authoritative for orchestrator-facing fields (`systemPrompt`, `additionalDirectories`, `mcpServers`, `model`, `skills`, content blocks). Backends translate down. NEVER smuggle Kodizm fields through `_meta` on the orchestrator edge; `src/wire/schemas.ts` enforces this via `.refine()` at runtime.
- Codex driver collapses 7 input methods (3 v2 approval RPCs `item/{commandExecution,fileChange,permissions}/requestApproval` + 2 legacy aliases `applyPatchApproval` + `execCommandApproval` + `item/tool/requestUserInput` + `mcpServer/elicitation/request` + `item/tool/call` + `account/chatgptAuthTokens/refresh`) into 4 canonical channels (`permission_request`, `question_request`, `session/dynamic_tool_call`, `session/codex_chatgpt_token_refresh`).
- Opencode driver subscribes to opencode's `/event` SSE stream, dispatches `permission.asked` + `question.asked` through canonical `permission_request` + `question_request`, and replies via `sdk.permission.reply` / `sdk.question.reply`.
- `AcpServerLike`, `EmitLike`, `DEFERRED_SENTINEL`, `awaitPermissionResponse` live in `src/backends/claude/permission-bridge.ts` and are imported by codex + opencode drivers + the bin. Cross-backend coupling: a 4th backend's permission-bridge / ask-user-question must import from the claude file. Move it before extracting if you ever split per-backend packages.
- `permissionTimeoutMs` and `permissionDeferTimeoutMs` are mutually exclusive (schema `.refine()` rejects both set). Pick hard-deny on timeout OR soft-defer on timeout, not both.

## Bin scope

`src/index.ts` (the published bin) only wires `KODIZM_BACKEND=claude`. `codex` and `opencode` are recognised by env but exit with code 2 and a "not yet wired" stderr line (`src/index.ts:295-308`). For now, codex and opencode require programmatic embedding: import `CodexDriver` / `OpencodeDriver`, build the transport + `createAcpServer` manually. Anything in this file that talks about all three backends "working through the bin" is wrong until that wiring lands.

## Codex specifics

- Field shape is camelCase v2: `threadId`, `turnId`, `itemId`, `approvalId`, `cwd`, `command`, `cachedInputTokens`, `tokenUsage.total.*`. Pre-v2 snake_case (`thread_id`, `item_id`, `conversationId`, `callId`) is auto-aliased in the approval pipeline.
- Item type discriminator is camelCase: `commandExecution`, `fileChange`, `mcpToolCall`, `contextCompaction`, `collabAgentToolCall`. Driver accepts both forms for forward + back compat.
- Reasoning chunks travel on dedicated methods (`item/reasoning/summaryTextDelta` + `item/reasoning/textDelta`), NOT via `subtype='reasoning'` on `agentMessage/delta`. Both routes feed canonical `thinking_chunk`.
- `codex app-server` has NO `--config <path>` flag. To inject `[mcp_servers.*]` etc., set `CODEX_HOME` to a temp dir + write `config.toml` there. Per-key overrides go via `-c key=value`.
- ChatGPT-mode auth ignores `model` overrides and silently keeps `gpt-5.5`. API-key auth honors them.
- Some features only expose with explicit feature flags: `features.default_mode_request_user_input=true` for `requestUserInput`, `features.request_permissions_tool=true` for permission grants, `features.multi_agent_v2=true` for `spawn_agent` (still account-tier gated; chatgpt-mode never invokes it organically regardless of Plus / Free).
- `hydrateSession({ sessionId, codexThreadId, codexJsonlPath, ... })` is the cross-process Pattern B entry: a fresh driver instance can resume a Kodizm sessionId by replaying codex's `thread/resume` against the persisted threadId. Public method on `CodexDriver`, NOT on `BackendDriver`.

## Opencode specifics

- Boot mode: `createOpencodeServer` from `@opencode-ai/sdk` (the official SDK helper that spawns `opencode serve --port 0 --hostname 127.0.0.1` under the hood, waits for the listening marker, returns `{url, close}`). NOT the raw `opencode/server` Effect/Hono runtime. One server per Kodizm session, `bridge.stop()` is the canonical session terminator.
- Prompt path: v1 `sdk.session.prompt({sessionID, model: {providerID, modelID}, parts})`. The v2 `sdk.v2.session.prompt()` only queues a message, does NOT drive the LLM loop. Always use v1 for actual turns.
- SDK reply shapes are flat: `sdk.permission.reply({requestID, reply, message?})`, `sdk.question.reply({requestID, answers})`, `sdk.question.reject({requestID})`. NOT `{id, body: {...}}` (older draft).
- Canonical model wire is `<providerID>/<modelID>` slash-separated (`opencode-go/deepseek-v4-flash`, `github-copilot/gpt-5-mini`, `anthropic/claude-haiku-4-5`). Driver splits on first `/`.
- MCP tool naming: opencode uses `<sanitizedServer>_<tool>` (single underscore). Canonical wire uses `mcp__<server>__<tool>` (double underscore). Driver maps both directions via the per-session reverseMap.
- Tool lifecycle latches: opencode emits multiple `running` updates as the tool's input record fills in. Event-mapper has `toolBegan`/`toolEnded` `Set<callID>` so canonical `tool_call_begin` + `tool_call_end` each fire exactly once per call.
- Permission ruleset must be passed at `session.create({permission})`; opencode does NOT have a per-driver default mode. The driver wires `buildOpencodeRuleset(toolPolicy)` at newSession.
- Auth via `OPENCODE_AUTH_CONTENT` env var, layered onto `process.env` only for the duration of `bridge.start()` then restored. No `~/.local/share/opencode/auth.json` mutation.
- Cross-process Pattern B is folded into `loadSession({sessionId, _meta.opencodeSessionId})`. No separate `hydrateSession` method; opencode's SQLite persistence survives process death.
- `ContextOverflowError` maps to `transport_error` (canonical SessionFailedReason has no `compaction_failure` code).

## Lifecycle and failure handling

- `SessionUpdateEvent` is a 21-variant discriminated union (`src/wire/events.ts`). When adding a new event, extend the union AND wire mapping in every backend's `event-mapper.ts`.
- `shouldExitOnReason` (`src/util/exit-policy.ts`) splits `session_failed` outcomes: `sdk_stall` / `transport_error` / `internal_panic` / `protocol_violation` exit the container; `sdk_throw` / `auth_error` / `rate_limit` keep it alive (orchestrator may retry).
- Pattern B deferred permissions: when the driver receives a `deferredStore`, it persists locally; when not, it falls back to outbound RPCs `session/permission_deferred_persist` (write) and `session/permission_deferred_state` (read). Both paths must be supported.
- Claude bridge detects subagent spawn/complete inline from the Task tool: `tool_use.name === 'Task'` triggers `subagent_spawn`; `tool_result` is scanned for `agentId:` line + `<usage>total_tokens: N tool_uses: M duration_ms: D</usage>` markers. `outputTokens` / `cacheReadTokens` / `cacheCreationTokens` / `costUsd` default to 0; `subagent_type` defaults to `'general-purpose'`. Lives in `src/backends/claude/event-mapper.ts:352+`.

## Gotchas

- **Stdout is reserved for ACP frames.** A single `console.log` corrupts the JSON-RPC stream and kills the session. Use `createLogger` from `@/util/logger` (stderr-only) for structured logs, or `process.stderr.write` for raw.
- **Run `bun test` from the package directory, not from `kodizm.com` root.** Bun 1.3.10 has a subprocess lifecycle quirk under `bun test` when invoked from a parent dir: spawned codex / opencode subprocesses see stdout EOF immediately and exit code 0 with no output. `cd packages/kodizm-acp && bun test ...` runs everything green.
- Bun-on-Bun (`bun run fakeBin.ts`) under `bun test` is unreliable; `BUN_TEST_*` env vars leak into the child and confuse Bun's nested runtime. The fake-codex fixture (`test/integration/_codex-fake-process.ts`) emits Node CJS scripts and uses `binaryPath: 'node'` to sidestep the issue entirely.
- `Bun.spawn({ env })` LAYERS env onto `process.env` by default. Pass `replaceEnv: true` (custom `CodexAppServerSpawnOptions` flag) when the test needs a fully-scrubbed environment.
- `KODIZM_ACP_FORWARD_STDERR=1` env var enables an opt-in stderr pump on the codex subprocess; the pump tees child stderr to parent's stderr for hang / crash diagnosis.
- `KODIZM_DEBUG_RAW_SECRETS=1` disables allow-list redaction inside `DebugRecorder` (`src/util/redaction.ts:62-71`). Incident-only; never set in production.
- Biome inlines short JSON arrays in config files (`package.json`, `biome.json`). My-coding's "always multi-line" rule applies to source code; accept biome's reformat for JSON.
- Path alias `@/` resolves to `src/` from `test/` only. Inside `src/`, use relative imports with `.ts` extension (`allowImportingTsExtensions: true` in tsconfig).
- Bun's `bun:test` is jest-compatible. Mocks via `mock(fn)`. No `vitest`, no `jest`. Single test: `bun test path -t 'pattern'`.
- `debug_log` has 10 stages: `rpc.in`, `rpc.out`, `sdk.message`, `sdk.error`, `tool.permission_request`, `tool.permission_response`, `session.config`, `driver.state_change`, `transport.spawn`, `transport.exit` (`src/wire/events.ts:210`).
- Opencode subprocesses leak between failed test runs. `pkill -f "opencode serve"` between iterations is sometimes required during local development.
- `debug-recorder.test.ts` flakes occasionally under parallel test load (~1 in 10 runs); re-run is the workaround. Pre-existing across all backends.
- Underscore-prefixed files in `test/integration/` (`_helpers.ts`, `_codex-fake-process.ts`, `_mcp-fixture.ts`, `_local-bin-task-tool.smoke.ts`) are fixtures / manual scripts, NOT bun:test suites.

## Test layout

| File | Layer | Count | Real CLI |
|------|------|------:|------|
| `test/unit/` | unit (mocked) | 600+ | partial (fake codex subprocess + real opencode bridge) |
| `test/e2e/` | full ACP roundtrip (mocked) | 5 | no |
| `test/integration/codex-real.smoke` | baseline | 3 | yes |
| `test/integration/codex-features.smoke` | F1-F7 | 7 | yes |
| `test/integration/codex-features-extended.smoke` | F8-F12+ | 7 | yes |
| `test/integration/codex-features-complete.smoke` | F13-F19 | 7 | yes (F18 lenient) |
| `test/integration/codex-features-deep.smoke` | F20-F28 | 9 | yes (F27 lenient) |
| `test/integration/codex-features-final.smoke` | A1-A4 + B1-B4 + C1-C4 | 17 | no (fake fixture) |
| `test/integration/codex-manual-compact.smoke` | manual `compact()` lever | 1 | no (fake fixture) |
| `test/integration/codex-auth-error.smoke` | B2 real | 1 | yes |
| `test/integration/codex-cross-process.smoke` | C3 real | 1 | yes |
| `test/integration/codex-thinking.smoke` | B4 real | 1 | yes (75 thinking_chunks at `reasoning_effort=high`) |
| `test/integration/codex-auth-refresh.smoke` | A3 real | 1 | yes |
| `test/integration/codex-mcp-elicit.smoke` | A1 real | 1 | yes (full SSE elicit roundtrip) |
| `test/integration/claude-*.smoke` (~17 files) | per-feature claude smokes | varies | yes, all gated on `HAS_AUTH` (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`) |
| `test/integration/opencode-features.smoke` | F1-F6 | 5 active + 1 skip | yes (`opencode-go/deepseek-v4-flash`, ~$0.05/run) |

## Submodule workflow

- Lives at `packages/kodizm-acp/` in parent `kodizm.com` as git submodule (`git@github.com:kodizm/acp.git`).
- Per-task commits push to `kodizm/acp` main directly. Parent submodule pointer bumps at phase end.
- Plans live in parent at `.ac/plans/kodizm-acp/`; don't duplicate planning notes inside the submodule.
