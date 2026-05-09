# kodizm-acp

ACP bridge that drives Claude Code, codex, and opencode CLIs through one canonical wire.

## What it is

`@kodizm/acp` is the Kodizm runtime's Agent Client Protocol bridge. It speaks one canonical JSON-RPC surface to the orchestrator, then translates each turn down to whichever CLI backend the session was opened against. The orchestrator never branches on backend; the same `session/new`, `session/prompt`, and `sessionUpdate` shapes carry every feature across all three.

Three CLIs are supported today: Claude Code (via `@anthropic-ai/claude-agent-sdk`), codex (via `codex app-server` subprocess), and opencode (via `createOpencodeServer` from `@opencode-ai/sdk`).

## How it works

```
+------------------+    JSON-RPC over    +------------------+    native protocol    +-----------+
|   Orchestrator   | <----- NDJSON ----> |    AcpServer     | <-------------------> |  Backend  |
|   (Kodizm core)  |     (stdio/pipe)    |  + BackendDriver |    (SDK / subproc)    |    CLI    |
+------------------+                     +------------------+                       +-----------+
```

1. `KODIZM_BACKEND` selects the driver at process boot. One process per backend.
2. `AcpServer` validates every inbound request against the canonical schema, then routes to the `BackendDriver` interface.
3. Each driver maps the canonical request to its CLI's native shape. Stream events flow back through `emit.send()` and surface as `sessionUpdate` notifications on the wire.

The driver contract is a single TypeScript interface with seven methods. The server never imports any concrete driver. New backends extend the registry; the wire layer does not change.

## Backend support

| Feature | Claude | codex | opencode |
|---------|:------:|:-----:|:--------:|
| `session/new`, `session/prompt`, `session/cancel` | yes | yes | yes |
| `session/load` (resume) | yes | yes | yes |
| `session/fork` | yes | yes | yes |
| `session/compact` (manual) | yes | yes | yes |
| Image content blocks | yes | yes | yes |
| Token + cost rollup (`usage` event) | yes | yes | yes |
| `additionalDirectories` (sandbox) | yes | yes | n/a |
| `mcpServers` injection | yes | yes | yes |
| `systemPrompt` replace + append | yes | yes | yes |
| `skills` pre-load | yes | n/a | n/a |
| Permissions (`permission_request`) | yes | yes | yes |
| `askUserQuestion` | yes | yes | yes |
| Subagent events | yes | yes | yes |
| Thinking events | yes | yes | yes |
| Cross-process Pattern B resume | yes | yes | yes |
| Debug capture | yes | yes | yes |

> [!NOTE]
> The published bin (`kodizm-acp` from `dist/index.js`) currently wires only `KODIZM_BACKEND=claude`. Codex and opencode drivers are fully implemented and tested, but reaching them today requires programmatic embedding (see [API reference](#api-reference)).

## Install

```bash
bun add @kodizm/acp
```

Requires Bun >= 1.1.0. The `codex` and `opencode` CLIs must be installed separately when you use those backends.

## Quick start

The bin runs over stdio:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' \
  | KODIZM_BACKEND=claude \
    CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-..." \
    CLAUDE_CODE_REMOTE=1 \
    bunx @kodizm/acp
```

Replace the credential pair with `ANTHROPIC_API_KEY=...` for the api-key path.

## Configuration

### Environment variables

| Variable | Required | Description |
|----------|:--------:|-------------|
| `KODIZM_BACKEND` | yes | `claude` / `codex` / `opencode` |
| `CLAUDE_CODE_OAUTH_TOKEN` + `CLAUDE_CODE_REMOTE=1` | claude (sub) | Subscription auth |
| `ANTHROPIC_API_KEY` | claude (api) | API key auth |
| `CLAUDE_CODE_PATH` | optional | Path to claude binary (default `/usr/local/bin/claude`) |
| `OPENAI_API_KEY` or `CODEX_API_KEY` | codex (api) | api-key path. Without it, codex falls back to chatgpt-mode auth in `~/.codex/auth.json` |
| `OPENCODE_AUTH_CONTENT` | opencode (env) | JSON keyed by providerID. Layered onto subprocess env for the bridge lifetime only. Without it, opencode reads `~/.local/share/opencode/auth.json` |
| `KODIZM_LOG_LEVEL` | optional | `debug` / `info` / `warn` / `error`. Default `info` |
| `KODIZM_DEBUG` | optional | `1` enables process-wide debug capture |
| `KODIZM_DEBUG_DIR` | optional | Forensic JSONL dir, default `/tmp/kodizm-debug` |
| `KODIZM_DEBUG_RAW_SECRETS` | incident-only | `1` disables redaction. Never set in production |
| `KODIZM_ACP_FORWARD_STDERR` | optional | `1` tees codex subprocess stderr to parent stderr |

Stdout is reserved for ACP frames. Logs go to stderr.

### Session options (`NewSessionRequest`)

```ts
type NewSessionRequest = {
  cwd: string                        // absolute path
  mcpServers: McpServer[]
  additionalDirectories?: string[]   // absolute paths
  systemPrompt?: string | { append: string }
  model?: string                     // e.g. 'claude-haiku-4-5-20251001'
  skills?: string[]                  // claude only
  toolPolicy?: ToolPolicy
  autoCompact?: boolean
  permissionTimeoutMs?: number       // mutually exclusive with permissionDeferTimeoutMs
  permissionDeferTimeoutMs?: number
  debug?: boolean
  debugCaptureRawSdk?: boolean
  debugCaptureRpc?: boolean
  heartbeatIntervalMs?: number
  inactivityThresholdMs?: number
  _meta?: Record<string, unknown>    // passthrough; canonical fields rejected
}
```

> [!WARNING]
> `permissionTimeoutMs` and `permissionDeferTimeoutMs` are mutually exclusive. Pick hard-deny on timeout OR soft-defer on timeout, not both. The schema rejects the conflict with a clear error.

### Tool policy

```ts
type ToolPolicy = {
  defaultMode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions'
  allow?: string[]   // e.g. ['Read', 'Bash:git status', 'mcp:server/tool']
  deny?: string[]
  ask?: string[]
}
```

The parser lives in `src/wire/policy.ts`. Each backend translates the canonical pattern grammar to its native rule shape.

### MCP servers

```ts
type McpServer = {
  type: 'http'
  name: string
  url: string
  headers?: { name: string; value: string }[]
}
```

Phase 1 ships the `http` transport. The codex driver writes per-server entries into a temporary `~/.codex/config.toml`; opencode adds servers via `sdk.mcp.add` per session.

## API reference

### `BackendDriver`

Every backend implements this contract:

```ts
interface BackendDriver {
  capabilities(): DriverCapabilities
  initialize(params: InitializeRequest): Promise<InitializeResult>
  newSession(params: NewSessionRequest): Promise<NewSessionResult>
  prompt(sessionId: string, params: PromptRequest, emit: EventEmitter): Promise<PromptResult>
  cancel(request: CancelRequest): Promise<void>
  loadSession(params: LoadSessionRequest): Promise<NewSessionResult>
  forkSession(params: ForkSessionRequest): Promise<NewSessionResult>
  compact(request: CompactSessionRequest, emit: EventEmitter): Promise<void>
}

interface DriverCapabilities {
  resume: boolean
  fork: boolean
  fileUpload: boolean
  thinking: boolean
  subagent: boolean
  skillEvents: boolean
  debug: boolean
  askQuestion: boolean
}
```

Capability gating runs at the dispatcher: `loadSession` rejects with `MethodNotSupportedError` (-32601) when `resume` is false; `forkSession` rejects when `fork` is false. The other six flags are advisory metadata for the orchestrator.

### Public exports

The bin (`src/index.ts`) is the only public surface. Importers get the runtime helpers, not the drivers themselves:

| Export | Purpose |
|--------|---------|
| `SupportedBackend` | `'claude' \| 'codex' \| 'opencode'` |
| `BackendNotConfiguredError`, `UnknownBackendError` | startup-time errors |
| `resolveBackendFromEnv(env)` | parse `KODIZM_BACKEND` from a captured env |
| `installShutdownHook()` | wire SIGTERM + SIGINT to graceful shutdown |
| `performShutdown(graceMs?)` | run the shutdown side-effects manually |
| `registerActiveRecorder(r)` | track a `DebugRecorder` for shutdown flush |
| `registerShutdownFlusher(fn)` | register the transport flush callback |
| `SHUTDOWN_GRACE_MS` | default 3s grace budget |
| `main()` | the bin's entry function |

Drivers, wire types, and `createAcpServer` are internal. To embed programmatically, import them directly from their module paths under `src/`.

### Programmatic embedding

```ts
import { ClaudeDriver } from '@kodizm/acp/src/backends/claude/driver.ts'
import { createAcpServer } from '@kodizm/acp/src/server/acp-server.ts'
import { createNdjsonTransport } from '@kodizm/acp/src/server/transport.ts'
import { query } from '@anthropic-ai/claude-agent-sdk'

const driver = new ClaudeDriver({
  credentials: { type: 'subscription', token: process.env.CLAUDE_CODE_OAUTH_TOKEN! },
  agentInfo: { version: '0.5.4' },
  sdk: { query: ({ prompt, options }) => query({ prompt, options }) },
})

const server = createAcpServer({
  transport: createNdjsonTransport({ readable, writable }),
  backend: driver,
})

await server.serve()
```

The `codex` and `opencode` drivers follow the same shape; their constructors take backend-specific factories (`spawnFactory` for codex, no factory for opencode since the SDK helper handles it).

## Wire reference

### JSON-RPC methods (inbound)

| Method | Purpose |
|--------|---------|
| `initialize` | handshake; returns `protocolVersion` + `agentInfo` + `capabilities` |
| `session/new` | open a session; returns `{ sessionId }` |
| `session/prompt` | drive a turn; streams `sessionUpdate` notifications, returns `PromptResult` |
| `session/cancel` | abort the in-flight prompt for a session |
| `session/load` | resume a prior session by id (gated on `resume`) |
| `session/fork` | branch a session with optional overrides (gated on `fork`) |
| `session/compact` | trigger manual context compaction |

`PromptResult.stopReason` is one of: `end_turn`, `cancelled`, `process_died`, `max_tokens`, `tool_use`, `session_failed`. When `session_failed`, the result also carries `failureReason` and `failureDetail`.

### `sessionUpdate` events

The `SessionUpdateEvent` discriminated union has 21 variants:

| Type | When |
|------|------|
| `output_chunk` | streaming model output |
| `thinking_chunk` | streaming reasoning |
| `tool_call_begin` / `progress` / `end` | tool lifecycle (one begin + one end per call) |
| `permission_request` | model wants to run a gated tool |
| `permission_deferred` / `permission_resumed` | Pattern B lifecycle |
| `question_request` | model asks the user a question |
| `usage` | token + cost rollup |
| `subagent_spawn` / `subagent_complete` | nested agent lifecycle |
| `skill_activation` | a skill loaded mid-turn (claude only) |
| `model_advertisement` | the actual model the backend chose |
| `process_died` | subprocess crash (codex / opencode) |
| `cancelled` | turn was cancelled |
| `compaction_started` / `compaction_completed` | context compaction; `trigger: 'manual' \| 'auto'` |
| `debug_log` | one of 10 stages: `rpc.in`, `rpc.out`, `sdk.message`, `sdk.error`, `tool.permission_request`, `tool.permission_response`, `session.config`, `driver.state_change`, `transport.spawn`, `transport.exit` |
| `heartbeat` | periodic liveness signal |
| `session_failed` | structured lifecycle failure |

### Outbound RPCs (server to orchestrator)

| Method | When |
|--------|------|
| `sessionUpdate` | every event above flows as a notification |
| `session/request_permission` | orchestrator decides on a `permission_request` |
| `session/ask_user_question` | orchestrator answers a `question_request` |
| `session/dynamic_tool_call` | codex orchestrator-hosted tool dispatch |
| `session/codex_chatgpt_token_refresh` | codex chatgpt-mode token rotation |
| `session/permission_deferred_persist` | Pattern B write fallback when no `deferredStore` |
| `session/permission_deferred_state` | Pattern B read fallback when no `deferredStore` |

The permission and ask-question RPC names have legacy aliases (`requestPermission`, `askUserQuestion`); both forms route to the same handler.

## Cross-process resume (Pattern B)

A driver instance can resume a session that an earlier process started. Useful when a container restart, deploy, or crash interrupts an active turn.

- **claude**: standard `session/load` against the SDK's resume mode; the JSONL transcript on disk is authoritative.
- **codex**: `CodexDriver.hydrateSession({ sessionId, codexThreadId, ... })` replays codex's `thread/resume` against the persisted threadId.
- **opencode**: `OpencodeDriver.loadSession({ sessionId, _meta: { opencodeSessionId } })`; opencode's SQLite persistence survives process death.

Deferred permissions (the orchestrator decided to "ask later" on a tool gate) are persisted via either an injected `DeferredPermissionStore` or the `session/permission_deferred_persist` outbound RPC. The next process picks up where the prior one left off and emits `permission_resumed`.

## Failure handling

`session_failed` carries one of seven reasons:

| Reason | Container action |
|--------|------------------|
| `sdk_stall` | exit |
| `transport_error` | exit |
| `internal_panic` | exit |
| `protocol_violation` | exit |
| `sdk_throw` | stay alive (orchestrator may retry) |
| `auth_error` | stay alive (orchestrator can refresh credentials) |
| `rate_limit` | stay alive (orchestrator backs off) |

The exit decision lives in `src/util/exit-policy.ts`. The bin consults it after a `session_failed` and triggers graceful shutdown when true.

## Development

```bash
bun install
bun test test/unit                       # mocked; ~600 tests
bun test test/e2e                        # full ACP roundtrip
bun test test/integration                # real-API smokes (requires creds)
bunx tsc --noEmit                        # typecheck
bunx biome check --write src test        # lint + format
bun run build                            # compile to dist/index.js
```

The integration suite gates each backend on its own auth probe; tests skip cleanly when credentials are not present.

## License

Apache-2.0. See `LICENSE`.
