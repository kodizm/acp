# kodizm-acp

Kodizm runtime's ACP bridge. One protocol controls Claude Code and codex CLIs (opencode arrives in Phase 3) under a single canonical surface, so the orchestrator wires every backend the same way: token rollup, model selection, system prompt replace + append, additional directories, MCP server injection, skill injection, image content blocks, thinking + output + tool streaming, subagent observability, resume + fork, permission + AskUserQuestion, MCP elicitation, dynamic tool dispatch, chatgpt token refresh, deferred-permission lifecycle (Pattern B incl. cross-process resume), debug capture, heartbeat liveness, structured failure events.

Status: Phase 1, 1.5, 1.6, 1.7, 2 complete (Claude + codex backends ship). Opencode (Phase 3) inherits the canonical seam unchanged.

## Backend parity matrix

Every Phase 1 / 1.5 / 1.6 / 1.7 / 2 surface is wired identically across the two shipping backends. The orchestrator does not branch on backend; the same canonical wire shape carries every feature.

| Feature | Claude | Codex |
|---------|--------|-------|
| `session/new` + `session/load` + `session/fork` + `session/cancel` | yes | yes |
| `session/prompt` text content blocks | yes | yes |
| `session/prompt` image content blocks (`{ type: 'image', uri: 'file://...' \| 'http(s)://...' }`) | yes | yes (mapped to `localImage` / `image` UserInput) |
| Token + cost rollup (`usage` event) | yes | yes |
| Model selection (`model` field + `model_advertisement` event) | yes | yes (api-key auth honors override; chatgpt-mode keeps default) |
| `additionalDirectories` -> sandbox | yes (SDK) | yes (`SandboxPolicy.WorkspaceWrite.writableRoots`) |
| `mcpServers` inline injection | yes (SDK options) | yes (CODEX_HOME `config.toml` + `[mcp_servers.*]`) |
| `systemPrompt` replace / append | yes | yes (codex `baseInstructions` / `developerInstructions`) |
| `skills` pre-load + `skill_activation` events | yes (`skillEvents: true`) | n/a (codex has no skill loader) |
| `toolPolicy.defaultMode` (5 enum) | yes | yes |
| `toolPolicy.allow` / `deny` / `ask` | yes (SDK rules) | yes (sandbox + permission profile) |
| `autoCompact` on/off | yes (`DISABLE_AUTO_COMPACT=1`) | yes (codex respects `model_auto_compact_token_limit`) |
| `permission_request` event + `session/request_permission` RPC | yes | yes (3 codex RPCs collapse to one canonical) |
| Legacy `applyPatchApproval` + `execCommandApproval` | n/a | yes (auto-aliased to v2 `item/*/requestApproval` shape) |
| `question_request` + `session/ask_user_question` RPC | yes (AskUserQuestion tool) | yes (`item/tool/requestUserInput` + `mcpServer/elicitation/request` both feed in) |
| `session/dynamic_tool_call` (orchestrator-hosted tools) | n/a | yes (codex `item/tool/call`) |
| `session/codex_chatgpt_token_refresh` | n/a | yes (codex `account/chatgptAuthTokens/refresh`) |
| `permission_deferred` + `permission_resumed` events (Pattern B) | yes | yes |
| Cross-process Pattern B (`hydrateSession()` API) | yes | yes |
| `session/permission_deferred_persist` + `session/permission_deferred_state` RPCs | yes | yes |
| Pattern B JSONL injection | `~/.claude/projects/.../<sessionId>.jsonl` | `~/.codex/sessions/rollout-*-<threadId>.jsonl` (resume-by-threadId) |
| `compaction_started` + `compaction_completed` events | yes | yes (`ContextCompaction` item lifecycle) |
| `subagent_spawn` + `subagent_complete` events | yes (Task tool) | yes (`CollabAgentToolCall`; chatgpt-mode tier-gated) |
| `tool_call_begin` / `progress` / `end` events | yes | yes (CommandExecution / FileChange / McpToolCall) |
| `output_chunk` event | yes | yes |
| `thinking_chunk` event | yes | yes (`item/reasoning/summaryTextDelta` + `item/reasoning/textDelta`) |
| `debug_log` (9 stages) + per-session toggle | yes | yes |
| `heartbeat` event | yes | yes |
| `session_failed` event + 7-value reason enum | yes | yes |
| Per-reason `shouldExitOnReason` exit policy | yes | yes |
| Graceful SIGTERM shutdown hook | yes | yes (subprocess `kill()` + grace) |
| `BackendStallError` (-32006) | yes | yes |

## Install

```bash
bun install
bun build src/index.ts --target=bun --outdir=dist
```

## Environment

| Variable | Description |
|----------|-------------|
| `KODIZM_BACKEND` | `claude` (Phase 1) / `codex` (Phase 2) / `opencode` (Phase 3, planned) |
| `CODEX_API_KEY` or `OPENAI_API_KEY` | codex backend api-key auth (alternative to chatgpt OAuth) |
| `CLAUDE_CODE_OAUTH_TOKEN` + `CLAUDE_CODE_REMOTE=1` | Subscription auth |
| `ANTHROPIC_API_KEY` | API key auth (fallback) |
| `KODIZM_LOG_LEVEL` | `debug` / `info` / `warn` / `error`. Default `info` |
| `KODIZM_DEBUG` | `1` enables process-wide debug capture |
| `KODIZM_DEBUG_DIR` | Forensic JSONL dir, default `/tmp/kodizm-debug` |
| `KODIZM_DEBUG_RAW_SECRETS` | `1` disables allow-list redaction (incident-only) |
| `KODIZM_ACP_FORWARD_STDERR` | `1` tees codex subprocess stderr to parent stderr (diagnosis) |

Stdout is reserved for ACP frames. Never log to stdout.

## Quick start

```bash
# Claude:
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' \
  | KODIZM_BACKEND=claude CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-..." CLAUDE_CODE_REMOTE=1 \
    bun run dist/index.js

# Codex (same protocol, just switch the backend env):
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' \
  | KODIZM_BACKEND=codex OPENAI_API_KEY="sk-..." \
    bun run dist/index.js
```

Programmatic embedding:

```ts
import { ClaudeDriver } from '@/backends/claude/driver.ts'
import { query } from '@anthropic-ai/claude-agent-sdk'

const driver = new ClaudeDriver({
  credentials: { type: 'subscription', token: process.env.CLAUDE_CODE_OAUTH_TOKEN! },
  agentInfo: { version: '0.0.1' },
  sdk: { query: ({ prompt, options }) => query({ prompt, options }) },
})

const { sessionId } = await driver.newSession({
  cwd: process.cwd(),
  mcpServers: [],
  model: 'claude-haiku-4-5-20251001',
})

const events: SessionUpdateEvent[] = []
const result = await driver.prompt(
  sessionId,
  { sessionId, prompt: [{ type: 'text', text: 'Say hi.' }] },
  { send: (event) => events.push(event) },
)
```

## API reference

### `createAcpServer({ transport, backend?, debugSink? })`

JSON-RPC 2.0 dispatcher over an NDJSON transport. When `backend` is set, the server auto-registers six lifecycle methods (`initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/load`, `session/fork`) with schema validation + capability gating. When `debugSink` is set, every inbound + outbound frame tees through `record('rpc.in' | 'rpc.out', frame)`.

```ts
import { createAcpServer } from '@/server/acp-server.ts'
import { createNdjsonTransport } from '@/server/transport.ts'
import { DebugRecorder } from '@/util/debug-recorder.ts'

const recorder = new DebugRecorder({
  sessionId: 's1',
  emit: { send: (e) => server.notify('sessionUpdate', e) },
  debug: true,
  debugFilePath: '/tmp/kodizm-debug/s1.jsonl',
})

const server = createAcpServer({
  transport: createNdjsonTransport({ readable: Bun.stdin.stream(), writable }),
  backend: driver,
  debugSink: recorder,
})

await server.serve()
```

### `RPC_METHOD_ALIASES`

The permission RPC name drifted between SDK drafts (`requestPermission` ↔ `session/request_permission`). Handlers registered under either form route to the same handler.

```ts
server.on('session/request_permission', handler)        // also: requestPermission
server.on('session/ask_user_question', askHandler)      // also: askUserQuestion
```

### `BackendDriver`

Every backend implements this contract.

```ts
interface BackendDriver {
  initialize(params: InitializeRequest): Promise<InitializeResult>
  newSession(params: NewSessionRequest): Promise<NewSessionResult>
  prompt(sessionId: string, params: PromptRequest, emit: EventEmitter): Promise<PromptResult>
  cancel(request: CancelRequest): Promise<void>
  loadSession(params: LoadSessionRequest): Promise<NewSessionResult>
  forkSession(params: ForkSessionRequest): Promise<NewSessionResult>
  capabilities(): DriverCapabilities
}

interface DriverCapabilities {
  resume: boolean
  fork: boolean
  fileUpload: boolean
  thinking: boolean
  subagent: boolean
  skillEvents: boolean
  debug: boolean
}

interface PromptResult {
  stopReason: 'end_turn' | 'cancelled' | 'process_died' | 'max_tokens' | 'tool_use' | 'session_failed'
  failureReason?: SessionFailedReason
  failureDetail?: string
}
```

### `ClaudeDriver`

```ts
const { sessionId } = await driver.newSession({
  cwd: '/workspace',
  mcpServers: [
    { type: 'http', name: 'kodizm', url: 'https://kodizm.com/mcp/internal',
      headers: [{ name: 'Authorization', value: 'Bearer kdz-int-jwt.x.y' }] },
  ],
  additionalDirectories: ['/data/shared'],
  systemPrompt: { append: 'Always respond in Turkish.' },
  model: 'claude-haiku-4-5-20251001',
  skills: ['my-coding'],
  toolPolicy: { defaultMode: 'default', allow: ['Read'], deny: ['Bash:git push*'] },
  autoCompact: false,
  permissionTimeoutMs: 30_000,
  permissionDeferTimeoutMs: 1_800_000,
  debug: true,
  heartbeatIntervalMs: 10_000,
  inactivityThresholdMs: 60_000,
})
```

Per-turn override:

```ts
await driver.prompt(
  sessionId,
  { sessionId, prompt: [...], model: 'claude-sonnet-4-6' },
  emit,
)
```

Cancel:

```ts
await driver.cancel({ sessionId })
// emits cancelled event; prompt() returns stopReason='cancelled'
```

### `CodexDriver`

Identical contract; just import the codex driver instead. The orchestrator does not branch on backend; every wire shape from `NewSessionRequest` down through `SessionUpdateEvent` is the same.

```ts
import { CodexDriver } from '@/backends/codex/driver.ts'
import { CodexAppServerProcess } from '@/backends/codex/app-server-spawn.ts'

const driver = new CodexDriver({
  agentInfo: { version: '0.0.1' },
  spawnFactory: async (options) => {
    const proc = new CodexAppServerProcess({
      binaryPath: 'codex',
      configPath: options.configPath,
    })
    await proc.spawn()
    return proc
  },
  server,           // for outbound canonical permission / ask / dynamic-tool / token-refresh RPCs
  deferredStore,    // optional Pattern B store
})

const { sessionId } = await driver.newSession({
  cwd: '/workspace',
  mcpServers: [
    { type: 'http', name: 'kodizm', url: 'https://kodizm.com/mcp/internal' },
  ],
  toolPolicy: { defaultMode: 'default' },
  systemPrompt: { append: 'Always respond in Turkish.' },
  permissionDeferTimeoutMs: 1_800_000,
  debug: true,
  heartbeatIntervalMs: 10_000,
  inactivityThresholdMs: 60_000,
})
```

The driver:
- spawns one `codex app-server --listen stdio://` subprocess per session (no `--config <path>` flag in app-server mode; per-key overrides via `-c key=value` and `[mcp_servers.*]` via CODEX_HOME's `config.toml`).
- maps canonical `permissionMode` 5-enum to codex's `AskForApproval` (`untrusted` / `on-failure` / `on-request` / `never`) + pairs `plan` mode with `ReadOnly` sandbox.
- maps canonical `systemPrompt` to codex's `baseInstructions` (string form) or `developerInstructions` (`{ append }` form) per `v2/ThreadStartParams.ts`.
- forwards canonical image content blocks to codex `UserInput`: `file://` paths and bare absolute paths become `localImage`; `http(s)://` URLs become `image`.
- collapses 7 codex serverRequest channels onto canonical wire:
  - 3 approval RPCs (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`) plus 2 legacy aliases (`applyPatchApproval`, `execCommandApproval`) -> canonical `permission_request` event with `name` discriminator (`codex_exec` / `codex_apply_patch` / `codex_permission_grant`).
  - `item/tool/requestUserInput` + `mcpServer/elicitation/request` -> canonical `question_request` event + `session/ask_user_question` RPC.
  - `item/tool/call` -> outbound `session/dynamic_tool_call` RPC.
  - `account/chatgptAuthTokens/refresh` -> outbound `session/codex_chatgpt_token_refresh` RPC.
- maps codex `ContextCompaction` items to canonical `compaction_started` / `compaction_completed`.
- maps codex `CollabAgentToolCall` items to canonical `subagent_spawn` / `subagent_complete` (parent `sessionId` + fresh Kodizm `childId`; codex thread ids never leak).
- routes codex `item/reasoning/summaryTextDelta` + `item/reasoning/textDelta` to canonical `thinking_chunk` (separate from `output_chunk`).
- writes Pattern B sentinel as `RolloutItem` line + resumes via `thread/resume { threadId }`.

### `CodexDriver.hydrateSession({ sessionId, codexThreadId, codexJsonlPath?, ... })`

Cross-process Pattern B entry. A fresh driver instance can resume a Kodizm sessionId by replaying codex's `thread/resume` against the persisted threadId. Use this when the original driver instance died (container restart, deploy, machine shutdown) and a new driver needs to consume a deferred-permission cached answer or keep streaming on the same Kodizm `sessionId`.

```ts
await driverB.hydrateSession({
  sessionId,                    // same Kodizm sessionId from Process A
  codexThreadId,                // captured from Process A's session state
  codexJsonlPath,               // optional; codex glob-resolves from threadId if absent
  cwd: process.cwd(),
  mcpServers: [],
  toolPolicy: { defaultMode: 'default' },
})

// Process B's first prompt automatically picks up the orchestrator's
// cached answer from the deferredStore + fires permission_resumed.
```

### `NewSessionRequest` schema

| Field | Type | Phase | Description |
|-------|------|-------|-------------|
| `cwd` | absolute path | 1 | Workspace root |
| `mcpServers` | array | 1 | MCP server inline injection |
| `additionalDirectories` | array | 1 | Extra read roots |
| `systemPrompt` | string \| `{append}` | 1 | Replace or append SDK preset |
| `model` | string | 1 | SDK model id |
| `skills` | string[] | 1 | Pre-loaded skill names |
| `toolPolicy` | object | 1.5 | `<ToolName>:<pattern>` rules + `defaultMode` |
| `autoCompact` | boolean | 1.5 | `false` injects `DISABLE_AUTO_COMPACT=1` |
| `permissionTimeoutMs` | int ms | 1.5 | Hard-deny on permission RPC timeout |
| `permissionDeferTimeoutMs` | int ms | 1.6 | Soft-defer on permission RPC timeout (Pattern B); mutually exclusive with `permissionTimeoutMs` |
| `debug` | boolean | 1.7 | Per-session debug capture toggle |
| `debugCaptureRawSdk` | boolean | 1.7 | Skip `sdk.message` + `sdk.error` |
| `debugCaptureRpc` | boolean | 1.7 | Skip `rpc.in` + `rpc.out` |
| `heartbeatIntervalMs` | int ms | 1.7 | Liveness ping cadence (default 10_000) |
| `inactivityThresholdMs` | int ms | 1.7 | SDK message gap threshold (default 60_000) |

### Event union (`@/wire/events`)

Discriminated on `type`. Every variant carries `sessionId`.

| Event | Phase | Carries |
|-------|-------|---------|
| `output_chunk` | 1 | `text` |
| `thinking_chunk` | 1 | `text` |
| `tool_call_begin` | 1 | `toolUseId`, `name`, `input` |
| `tool_call_progress` | 1 | `toolUseId`, `delta` |
| `tool_call_end` | 1 | `toolUseId`, `result`, `isError` |
| `usage` | 1 | 4 token counts + `costUsd` |
| `subagent_spawn` / `subagent_complete` | 1 | child token slice |
| `skill_activation` | 1 | `skillName`, `source` |
| `model_advertisement` | 1 | `model` |
| `process_died` / `cancelled` | 1 | terminal |
| `permission_request` | 1.5 | `toolUseId`, `name`, `options[]`, `agentId?` |
| `question_request` | 1.5 | `toolUseId`, `questions[]` |
| `compaction_started` / `compaction_completed` | 1.5 | trigger + token counts |
| `permission_deferred` / `permission_resumed` | 1.6 | Pattern B |
| `debug_log` | 1.7 | `level`, `stage`, `capturedAt`, `payload`, `redacted?` |
| `heartbeat` | 1.7 | `uptimeMs`, `lastSdkMs` |
| `session_failed` | 1.7 | `reason`, `detail`, `capturedAt`, `cause?` |

### Permission flow (`@/backends/claude/permission-bridge`)

```ts
import { buildCanUseTool } from '@/backends/claude/permission-bridge.ts'

const canUseTool = buildCanUseTool({
  server,
  sessionId: 's1',
  emit,
  signal: abortController.signal,
  permissionTimeoutMs: 30_000,
  deferTimeoutMs: 1_800_000,
  onDefer: ({ toolName, input, options }) => driverDeferHandler(...),
})
```

Outcomes:
- `selected.allow` → `{ behavior: 'allow', updatedInput }`
- `selected.allow_always` → `{ behavior: 'allow', ..., updatedPermissions }`
- `selected.reject` (or other) → `{ behavior: 'deny', message }`
- `cancelled` → throws `Tool use aborted`
- `AcpTimeoutError` → `{ behavior: 'deny', message: 'Permission RPC timed out' }`
- `DEFERRED_SENTINEL` → calls `onDefer` (Pattern B JSONL injection + state persist)

### Deferred permission, Pattern B (`@/backends/claude/deferred-permission`)

Process A defers when `permissionDeferTimeoutMs` elapses without an answer:

```ts
//   1. writeDeferredToolResult(jsonlPath, toolUseId)        // synthetic JSONL row
//   2. deferredStore.set(sessionId, { toolUseId, ...input }) // state persistence
//   3. emit { type: 'permission_deferred', sessionId, toolUseId, name }
//   4. canUseTool returns { behavior: 'deny', interrupt: true }  (SDK unwinds)
```

Process B resumes when the orchestrator caches an answer:

```ts
//   1. one-shot deferredStore.get(sessionId) lookup at first prompt
//   2. retry prefix injected into user prompt
//   3. canUseTool wrap fires cached answer for matching tool name
//   4. emit { type: 'permission_resumed', sessionId, toolUseId, decision }
//   5. deferredStore.delete(sessionId) (one-shot consumption)
```

Marker `__KODIZM_PERMISSION_DEFERRED__` flags rows the orchestrator's audit pipeline filters.

```ts
import { type DeferredPermissionStore, InMemoryDeferredStore } from '@/session/deferred-store.ts'

const driver = new ClaudeDriver({
  credentials, agentInfo, sdk, server,
  deferredStore: new InMemoryDeferredStore(),
})
```

Without `deferredStore`, the driver issues `session/permission_deferred_persist` (write) + `session/permission_deferred_state` (read) outbound RPCs.

### Debug capture (`@/util/debug-recorder`)

```ts
import { DebugRecorder } from '@/util/debug-recorder.ts'

const recorder = new DebugRecorder({
  sessionId: 's1',
  emit: { send: (e) => orchestratorWire.notify(e) },
  debug: true,
  debugFilePath: '/tmp/kodizm-debug/s1.jsonl',
  debugCaptureRawSdk: true,
  debugCaptureRpc: true,
  rawSecretsMode: false,
})

recorder.record('sdk.message', sdkMsg)
recorder.record('rpc.in', frame)
await recorder.flushPending()
recorder.close()
```

Stages: `rpc.in`, `rpc.out`, `sdk.message`, `sdk.error`, `tool.permission_request`, `tool.permission_response`, `session.config`, `driver.state_change`, `transport.spawn`, `transport.exit`.

Allow-list redaction masks `sk-ant-(api|oat|ort)*`, `Bearer`, `apiKey=value`, `kdz-*` patterns. Override via `KODIZM_DEBUG_RAW_SECRETS=1`.

### Heartbeat + inactivity (`@/server/heartbeat`)

```ts
import { HeartbeatTimer } from '@/server/heartbeat.ts'

const timer = new HeartbeatTimer({
  sessionId: 's1',
  intervalMs: 10_000,
  emit,
  getLastSdkMs: () => state.lastSdkMessageAt,
})
timer.start(Date.now())
// ... prompt runs ...
timer.stop()
```

`ClaudeDriver.prompt()` and `CodexDriver.prompt()` instantiate one timer per turn when `heartbeatIntervalMs` is set. The inactivity probe runs alongside; when the SDK message gap exceeds `inactivityThresholdMs`, the driver emits `session_failed { reason: 'sdk_stall' }` + aborts the per-turn controller.

### Structured failures (`@/backends/{claude,codex}/error-classifier`)

```ts
import { classifyClaudeError } from '@/backends/claude/error-classifier.ts'
import { classifyCodexError } from '@/backends/codex/error-classifier.ts'
import { shouldExitOnReason } from '@/util/exit-policy.ts'

const classified = classifyClaudeError(err)
// { reason: 'auth_error' | 'rate_limit' | 'transport_error' | 'sdk_throw' | ..., detail }

if (shouldExitOnReason(classified.reason)) {
  // sdk_stall, transport_error, internal_panic, protocol_violation -> exit
} else {
  // sdk_throw, auth_error, rate_limit -> stay alive, orchestrator may retry
}
```

### Graceful shutdown (`@/server/shutdown`)

```ts
import { runShutdown } from '@/server/shutdown.ts'

const result = await runShutdown({
  graceMs: 3_000,
  flushRecorders: async () => Promise.all(activeRecorders.map((r) => r.flushPending())),
  flushTransport: () => transport.flush(),
  emitFinal: (e) => server.notify('sessionUpdate', e),
  finalReason: 'transport_error',
  finalDetail: 'SIGTERM received',
  finalSessionIds: [...activeSessionIds],
})
// result.timedOut, result.errors
```

Bin entrypoint installs SIGTERM + SIGINT handlers automatically:

```ts
import { installShutdownHook, registerActiveRecorder, registerShutdownFlusher } from 'kodizm-acp'

installShutdownHook()
const dispose = registerActiveRecorder(recorder)
registerShutdownFlusher(() => transport.flush())
```

### Tool policy grammar (`@/wire/policy`)

| Canonical | Claude SDK |
|-----------|------------|
| `Read` | `Read` |
| `Read:/workspace/**` | `Read(/workspace/**)` |
| `Bash:git commit*` | `Bash(git commit:*)` |
| `mcp:kodizm` | `mcp__kodizm` |
| `mcp:kodizm/*` | `mcp__kodizm__*` |
| `mcp:kodizm/create_task` | `mcp__kodizm__create_task` |

```ts
import { parseCanonicalPattern } from '@/wire/policy.ts'

const parsed = parseCanonicalPattern('Bash:git commit*')
// { toolName: 'Bash', argPattern: 'git commit*' }
```

### Error codes (`@/server/errors`)

| Error | Code |
|-------|------|
| `MethodNotFoundError` / `MethodNotSupportedError` | -32601 |
| `InvalidParamsError` / `SessionNotFoundError` | -32602 |
| `InternalError` | -32603 |
| `ProcessDiedError` | -32001 |
| `CancelledError` | -32002 |
| `BackendDriverError` | -32003 |
| `AcpTimeoutError` | -32004 |
| `AcpProtocolError` | -32005 |
| `BackendStallError` | -32006 |

## Codex CLI specifics

Codex's app-server protocol drifts from claude's SDK in subtle ways the driver normalizes:

- **Field shape is camelCase v2**: `threadId`, `turnId`, `itemId`, `approvalId`, `cachedInputTokens`, `tokenUsage.total.*`. Pre-v2 snake_case (`thread_id`, `item_id`) and the legacy `conversationId` / `callId` shape from `applyPatchApproval` / `execCommandApproval` are auto-aliased in the approval pipeline.
- **Item type discriminator is camelCase**: `commandExecution`, `fileChange`, `mcpToolCall`, `contextCompaction`, `collabAgentToolCall`. Driver accepts both `PascalCase` and `camelCase` for forward + back compat.
- **Reasoning chunks travel on dedicated methods**, NOT via `subtype='reasoning'` on `agentMessage/delta`. The driver routes `item/reasoning/summaryTextDelta` + `item/reasoning/textDelta` to canonical `thinking_chunk`.
- **`codex app-server` has NO `--config <path>` flag.** To inject `[mcp_servers.*]` etc., set `CODEX_HOME` to a temp dir + write `config.toml` there. Per-key overrides via `-c key=value`.
- **ChatGPT-mode auth ignores `model` overrides** and silently keeps `gpt-5.5`. API-key auth honors them.
- **Some features only expose with explicit feature flags**:
  - `features.default_mode_request_user_input=true` for `requestUserInput` tool
  - `features.request_permissions_tool=true` for permission grants
  - `features.multi_agent_v2=true` for `spawn_agent` (still account-tier gated; chatgpt-mode never invokes it organically regardless of Plus / Free)

## Run tests

Always run from the package directory (Bun 1.3.10 has a subprocess lifecycle quirk under `bun test` when invoked from a parent dir).

```bash
cd packages/kodizm-acp

# Unit + e2e (mocked SDK + fake codex subprocess)
bun test test/unit test/e2e

# Real-CLI smoke (requires CLAUDE_CODE_OAUTH_TOKEN or codex login)
bun test test/integration

# Specific real-codex suites
bun test test/integration/codex-features.smoke.test.ts
bun test test/integration/codex-thinking.smoke.test.ts
bun test test/integration/codex-mcp-elicit.smoke.test.ts
```

Coverage at last run (ChatGPT Plus + Claude OAuth on host):

| Layer | Tests | Source |
|-------|------:|--------|
| Unit + e2e | 525 + | `test/unit/`, `test/e2e/` |
| Codex baseline real-CLI | 3 | `codex-real.smoke` |
| Codex features F1-F19 real-CLI | 21 | `codex-features.smoke`, `codex-features-extended.smoke`, `codex-features-complete.smoke` |
| Codex deep F20-F28 real-CLI | 9 | `codex-features-deep.smoke` |
| Codex final A1-A4 + B1-B4 + C1-C4 (deterministic fake fixture) | 17 | `codex-features-final.smoke` |
| Codex dedicated real-CLI (auth_error, cross-process, thinking, auth_refresh, mcp_elicit) | 5 | per-file smokes |

## License

Apache-2.0.
