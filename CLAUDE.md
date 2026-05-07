# kodizm-acp

Package-scoped overlay. Parent `kodizm.com` CLAUDE.md + `my-coding` skill cover everything else; only project-specific facts live here.

## Commands

| Command | Purpose |
|---------|---------|
| `bun test test/unit` | unit suite (mocked SDK + fake codex subprocess) |
| `bun test test/e2e` | full ACP roundtrip, mocked SDK |
| `bun test test/integration` | real-API smoke (Claude SDK + real codex CLI + real opencode CLI) |
| `bun test test/integration/codex-features-final.smoke.test.ts` | fake-fixture deterministic codex coverage (17 tests) |
| `bun test test/integration/opencode-features.smoke.test.ts` | real-LLM opencode F1-F6 against `opencode-go/deepseek-v4-flash` |
| `bunx tsc --noEmit` | typecheck (Bundler resolution, `@/` alias) |
| `bunx biome check --write src test` | lint + format with auto-fix |

## Architecture invariants

- One process per `KODIZM_BACKEND` value. Backend selection is spawn-time; not switchable mid-process.
- All backends implement `BackendDriver` (`src/backends/driver.ts`). Adding new backends does not touch `AcpServer`.
- `DriverCapabilities` carries 8 flags: `resume`, `fork`, `fileUpload`, `thinking`, `subagent`, `skillEvents`, `debug`, `askQuestion`. Every driver fills all 8.
- Kodizm canonical wire shape (`src/wire/`) is authoritative for orchestrator-facing fields (`systemPrompt`, `additionalDirectories`, `mcpServers`, `model`, `skills`, content blocks). Backends translate down. NEVER smuggle Kodizm fields through `_meta` on the orchestrator edge.
- Codex driver collapses 4 codex serverRequest channels onto canonical wire: 3 approval RPCs to `permission_request`, `item/tool/requestUserInput` + `mcpServer/elicitation/request` to `question_request`, `item/tool/call` to `session/dynamic_tool_call`, `account/chatgptAuthTokens/refresh` to `session/codex_chatgpt_token_refresh`.
- Opencode driver subscribes to opencode's `/event` SSE stream, dispatches `permission.asked` + `question.asked` through canonical `permission_request` + `question_request`, and replies via `sdk.permission.reply` / `sdk.question.reply`.

## Codex specifics

- Field shape is camelCase v2: `threadId`, `turnId`, `itemId`, `approvalId`, `cwd`, `command`, `cachedInputTokens`, `tokenUsage.total.*`. Pre-v2 snake_case (`thread_id`, `item_id`, `conversationId`, `callId`) is auto-aliased in the approval pipeline.
- Item type discriminator is camelCase: `commandExecution`, `fileChange`, `mcpToolCall`, `contextCompaction`, `collabAgentToolCall`. Driver accepts both forms for forward + back compat.
- Reasoning chunks travel on dedicated methods (`item/reasoning/summaryTextDelta` + `item/reasoning/textDelta`), NOT via `subtype='reasoning'` on `agentMessage/delta`. Both routes feed canonical `thinking_chunk`.
- `codex app-server` has NO `--config <path>` flag. To inject `[mcp_servers.*]` etc., set `CODEX_HOME` to a temp dir + write `config.toml` there. Per-key overrides go via `-c key=value`.
- ChatGPT-mode auth ignores `model` overrides and silently keeps `gpt-5.5`. API-key auth honors them.
- Some features only expose with explicit feature flags: `features.default_mode_request_user_input=true` for `requestUserInput`, `features.request_permissions_tool=true` for permission grants, `features.multi_agent_v2=true` for `spawn_agent` (still account-tier gated; chatgpt-mode never invokes it organically regardless of Plus / Free).
- `hydrateSession({ sessionId, codexThreadId, codexJsonlPath, ... })` is the cross-process Pattern B entry: a fresh driver instance can resume a Kodizm sessionId by replaying codex's `thread/resume` against the persisted threadId.

## Opencode specifics

- Boot mode: `createOpencodeServer` from `@opencode-ai/sdk` (the official SDK helper that spawns `opencode serve --port 0 --hostname 127.0.0.1` under the hood, waits for the listening marker, returns `{url, close}`). NOT the raw `opencode/server` Effect/Hono runtime. One server per Kodizm session, `bridge.stop()` is the canonical session terminator.
- Prompt path: v1 `sdk.session.prompt({sessionID, model: {providerID, modelID}, parts})`. The v2 `sdk.v2.session.prompt()` only queues a message, does NOT drive the LLM loop. Always use v1 for actual turns.
- SDK reply shapes are flat: `sdk.permission.reply({requestID, reply, message?})`, `sdk.question.reply({requestID, answers})`, `sdk.question.reject({requestID})`. NOT `{id, body: {...}}` (older draft).
- Canonical model wire is `<providerID>/<modelID>` slash-separated (`opencode-go/deepseek-v4-flash`, `github-copilot/gpt-5-mini`, `anthropic/claude-haiku-4-5`). Driver splits on first `/`.
- MCP tool naming: opencode uses `<sanitizedServer>_<tool>` (single underscore). Canonical wire uses `mcp__<server>__<tool>` (double underscore). Driver maps both directions via the per-session reverseMap.
- Tool lifecycle latches: opencode emits multiple `running` updates as the tool's input record fills in. Event-mapper has `toolBegan`/`toolEnded` `Set<callID>` so canonical `tool_call_begin` + `tool_call_end` each fire exactly once per call.
- Permission ruleset must be passed at `session.create({permission})`; opencode does NOT have a per-driver default mode. The driver wires `buildOpencodeRuleset(toolPolicy)` at newSession.
- Auth via `OPENCODE_AUTH_CONTENT` env var, layered onto `process.env` only for the duration of `bridge.start()` then restored. No `~/.local/share/opencode/auth.json` mutation.
- `ContextOverflowError` maps to `transport_error` (canonical SessionFailedReason has no `compaction_failure` code).

## Gotchas

- **Stdout is reserved for ACP frames.** A single `console.log` corrupts the JSON-RPC stream and kills the session. Use `createLogger` from `@/util/logger` (stderr-only).
- **Run `bun test` from the package directory, not from `kodizm.com` root.** Bun 1.3.10 has a subprocess lifecycle quirk under `bun test` when invoked from a parent dir: spawned codex / opencode subprocesses see stdout EOF immediately and exit code 0 with no output. `cd packages/kodizm-acp && bun test ...` runs everything green.
- Bun-on-Bun (`bun run fakeBin.ts`) under `bun test` is unreliable; `BUN_TEST_*` env vars leak into the child and confuse Bun's nested runtime. The fake-codex fixture (`test/integration/_codex-fake-process.ts`) emits Node CJS scripts and uses `binaryPath: 'node'` to sidestep the issue entirely.
- `Bun.spawn({ env })` LAYERS env onto `process.env` by default. Pass `replaceEnv: true` (custom `CodexAppServerSpawnOptions` flag) when the test needs a fully-scrubbed environment.
- `KODIZM_ACP_FORWARD_STDERR=1` env var enables an opt-in stderr pump on the codex subprocess; the pump tees child stderr to parent's stderr for hang / crash diagnosis.
- Biome inlines short JSON arrays in config files (`package.json`, `biome.json`). My-coding's "always multi-line" rule applies to source code; accept biome's reformat for JSON.
- Path alias `@/` resolves to `src/` from `test/` only. Inside `src/`, use relative imports with `.ts` extension (`allowImportingTsExtensions: true` in tsconfig).
- Bun's `bun:test` is jest-compatible. Mocks via `mock(fn)`. No `vitest`, no `jest`.
- Opencode subprocesses leak between failed test runs. `pkill -f "opencode serve"` between iterations is sometimes required during local development.
- `debug-recorder.test.ts` flakes occasionally under parallel test load (1 in ~10 runs); re-run is the workaround. Pre-existing across all backends.

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
| `test/integration/codex-auth-error.smoke` | B2 real | 1 | yes |
| `test/integration/codex-cross-process.smoke` | C3 real | 1 | yes |
| `test/integration/codex-thinking.smoke` | B4 real | 1 | yes (75 thinking_chunks at `reasoning_effort=high`) |
| `test/integration/codex-auth-refresh.smoke` | A3 real | 1 | yes |
| `test/integration/codex-mcp-elicit.smoke` | A1 real | 1 | yes (full SSE elicit roundtrip) |
| `test/integration/opencode-features.smoke` | F1-F6 (token rollup, model_advertisement, multi-turn memory, askUserQuestion, permission allow, fork) | 5 active + 1 skip-branch | yes (`opencode-go/deepseek-v4-flash`, ~$0.05/run) |

## Submodule workflow

- Lives at `packages/kodizm-acp/` in parent `kodizm.com` as git submodule (`git@github.com:kodizm/acp.git`).
- Per-task commits push to `kodizm/acp` main directly. Parent submodule pointer bumps at phase end.
- Plans live in parent at `.ac/plans/kodizm-acp/`; don't duplicate planning notes inside the submodule.
