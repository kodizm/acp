# kodizm-acp

Kodizm runtime's ACP bridge. One protocol controls Claude Code, opencode, and codex CLIs under the same canonical surface, so the orchestrator wires every backend the same way: token rollup, model selection, system prompt replace + append, additional directories, MCP server injection, skill injection, file upload, thinking + output + tool streaming, subagent observability, resume + fork, permission + AskUserQuestion, deferred-permission lifecycle (Pattern B), debug capture, heartbeat liveness, structured failure events.

Status: Phase 1, 1.5, 1.6, 1.7 complete. Codex (Phase 2) and opencode (Phase 3) inherit the canonical seam unchanged.

## Install

```bash
bun install
bun build src/index.ts --target=bun --outdir=dist
```

## Environment

| Variable | Description |
|----------|-------------|
| `KODIZM_BACKEND` | `claude` (Phase 1) / `codex` (Phase 2) / `opencode` (Phase 3) |
| `KODIZM_LOG_LEVEL` | `debug` / `info` / `warn` / `error`. Default `info` |
| `KODIZM_DEBUG` | `1` enables process-wide debug capture |
| `KODIZM_DEBUG_DIR` | Forensic JSONL dir, default `/tmp/kodizm-debug` |
| `KODIZM_DEBUG_RAW_SECRETS` | `1` disables allow-list redaction (incident-only) |
| `CLAUDE_CODE_OAUTH_TOKEN` + `CLAUDE_CODE_REMOTE=1` | Subscription auth |
| `ANTHROPIC_API_KEY` | API key auth (fallback) |

Stdout is reserved for ACP frames. Never log to stdout.

## Quick start

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' \
  | KODIZM_BACKEND=claude CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-..." CLAUDE_CODE_REMOTE=1 \
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

`ClaudeDriver.prompt()` instantiates one timer per turn when `heartbeatIntervalMs` is set. The inactivity probe runs alongside; when SDK message gap exceeds `inactivityThresholdMs`, the driver emits `session_failed { reason: 'sdk_stall' }` + aborts the per-turn controller.

### Structured failures (`@/backends/claude/error-classifier`)

```ts
import { classifyClaudeError } from '@/backends/claude/error-classifier.ts'
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

### Run tests

```bash
bun test                                   # unit + e2e
CLAUDE_CODE_OAUTH_TOKEN=... bun test       # + integration smokes
```

## License

Apache-2.0.
