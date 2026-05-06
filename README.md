# kodizm-acp

Custom ACP (Agent Client Protocol) server for the Kodizm runtime. Bridges Claude Code, codex, and opencode CLIs through a single Kodizm-flavored ACP surface, replacing the upstream `claude-agent-acp` and `codex-agent` adapters with one maintained codebase.

Status: **early development**. Phase 1 of 5 (bootstrap + Claude backend) in progress.

## Roadmap

| Wave | Tasks | Status |
|------|-------|--------|
| 0, bootstrap | T1-T4 | done |
| 1, ACP server core | T5-T9 | done |
| 2, canonical wire shape | T10-T12 | done |
| 3, backend driver + registry | T13-T15 | done |
| 4, Claude SDK driver | T16-T20 | done |
| 5, feature plumbing | T21-T28 | pending |
| 6, integration + e2e | T29-T31 | pending |

Phase 2 (codex backend), 3 (opencode backend), 4 (Laravel cutover), 5 (image bake + smoke) follow.

## Architecture

The server is a long-running process inside a Kodizm Project container. It speaks ACP (NDJSON JSON-RPC 2.0 over stdio) to the orchestrator, and internally drives one of three backends per process:

```
[ orchestrator ]  ──ACP──>  kodizm-acp (Bun TS)  ──> @anthropic-ai/claude-agent-sdk    (Claude)
                                                ──> codex app-server (subprocess)      (Codex)
                                                ──> opencode HTTP server (in-process)  (Opencode)
```

The backend is selected at process start via the `KODIZM_BACKEND` env var. One process serves one or more sessions of the chosen backend; backends are not switchable mid-process.

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `KODIZM_BACKEND` | yes | One of `claude` (phase 1) / `codex` (phase 2) / `opencode` (phase 3). |
| `KODIZM_LOG_LEVEL` | no | `debug` / `info` / `warn` / `error`. Default `info`. Logs land on stderr. |
| `KODIZM_MCP_TOKEN` | per session | Per-session JWT minted by the orchestrator and forwarded inline on `session/new` and via env. |
| `CLAUDE_CODE_OAUTH_TOKEN` | claude only | Subscription pool token; preferred over API key when both are set. |
| `ANTHROPIC_API_KEY` | claude only (api-key path) | Falls back when subscription token is absent. |
| `OPENAI_API_KEY` | codex only | Codex auth. Phase 2. |

stdout is reserved for ACP frames. Never log to stdout.

## Build

```bash
bun install                                      # resolve deps
bun build src/index.ts --target=bun --outdir=dist  # standalone bin
```

## Dev

```bash
bun run dev                                      # watch + run from src
bun test                                         # unit + e2e (mocked)
bun test test/unit                               # unit only
bun test test/e2e                                # e2e mocked pipeline
ANTHROPIC_API_KEY=sk-... bun test:integration    # real-API smoke (gated)
bunx tsc --noEmit                                # typecheck
bunx biome check src test                        # lint
bunx biome check --write src test                # format + lint with auto-fix
```

## How to use (current modules)

The bin is not yet runnable end-to-end (backend driver lands in Wave 3-4). The Wave 0 + Wave 1 modules are usable as building blocks today.

### `@/util/logger`, stderr-only structured logger

Stdout is reserved for the ACP wire. Use this helper instead of `console.log`.

```ts
import { createLogger } from '@/util/logger.ts'

const log = createLogger({ env: process.env })
log.info('boot', { backend: 'claude' })
// stderr <- {"level":"info","message":"boot","timestamp":"2026-05-06T...","backend":"claude"}
```

### `@/server/transport`, NDJSON stdio transport

Wraps a `ReadableStream<Uint8Array>` + `WritableStream<Uint8Array>` pair as the wire layer. Handles UTF-8 multi-byte chunks, partial line buffering, and malformed-line skipping via an optional callback.

```ts
import { createNdjsonTransport } from '@/server/transport.ts'

const transport = createNdjsonTransport({
  readable: Bun.stdin.stream(),
  writable: new WritableStream({ /* sink to stdout */ }),
  onInvalidFrame: (raw, err) => log.warn('drop bad frame', { raw, err }),
})

for await (const frame of transport.readFrames()) {
  // frame: parsed JSON value
}

await transport.writeFrame({ jsonrpc: '2.0', id: 1, result: {} })
```

### `@/server/acp-server`, JSON-RPC 2.0 dispatch

Layers protocol semantics on top of the transport. Method handlers register via `on(method, handler)`. Outbound requests use `request(method, params)` with automatic id correlation.

```ts
import { createAcpServer } from '@/server/acp-server.ts'

const server = createAcpServer({ transport })

server.on('initialize', (params) => ({ protocolVersion: 1 }))
server.on('session/new', async (params) => ({ sessionId: 's1' }))

// Outbound (e.g., asking the orchestrator for permission):
const decision = await server.request('session/request_permission', {
  sessionId: 's1',
  toolCall: { name: 'kodizm__create_task' },
})

server.notify('sessionUpdate', { sessionId: 's1', payload: '...' })

await server.serve()  // blocks until transport EOF
```

### `@/server/acp-server`, RPC method aliases

The permission RPC name drifted between SDK drafts (`requestPermission` vs `session/request_permission`). Handlers registered under either form route to the same handler bidirectionally.

```ts
import { RPC_METHOD_ALIASES, createAcpServer } from '@/server/acp-server.ts'

server.on('session/request_permission', handler)
// Both wire forms now hit `handler`:
//   { jsonrpc: '2.0', id: 1, method: 'session/request_permission', ... }
//   { jsonrpc: '2.0', id: 2, method: 'requestPermission', ... }
```

### `@/server/lifecycle`, terminator probes

Mirrors the Laravel-side `AcpClient::request()` four-probe ladder. Returns the first matching error in priority order: process death > cancel-past-grace > deadline.

```ts
import { pollTerminators, validateProtocolFrame } from '@/server/lifecycle.ts'

const result = pollTerminators({
  isAlive: () => transport.alive,
  cancelledAt: state.cancelledAt,        // null until session/cancel arrives
  sessionId: 's1',
  graceSeconds: 2,                       // CANCEL_GRACE_SECONDS_DEFAULT
  deadlineMs: Date.now() + 60_000,
})
if (result !== null) throw result        // ProcessDiedError | CancelledError | AcpTimeoutError

// Per-frame protocol validation:
const frame = await readNext()
const protoError = validateProtocolFrame(frame)
if (protoError) throw protoError         // AcpProtocolError
```

### `@/server/errors`, typed JsonRpcError subclasses

Wire-shape error responses + startup-only errors.

```ts
import {
  AcpProtocolError,
  AcpTimeoutError,
  BackendDriverError,
  CancelledError,
  InternalError,
  InvalidParamsError,
  MethodNotFoundError,
  ProcessDiedError,
  SessionNotFoundError,
  toJsonRpcResponse,
} from '@/server/errors.ts'

throw new InvalidParamsError('cwd must be absolute', { field: 'cwd' })

// Convert any thrown value to a wire response:
const response = toJsonRpcResponse(requestId, error)
// { jsonrpc: '2.0', id: <reqId>, error: { code: <-32xxx>, message, data? } }
```

| Error | Code | When |
|-------|------|------|
| `MethodNotFoundError` | -32601 | unregistered method |
| `MethodNotSupportedError` | -32601 | driver lacks capability for method |
| `InvalidParamsError` | -32602 | handler validation rejection |
| `InternalError` | -32603 | catch-all for unexpected throws |
| `SessionNotFoundError` | -32602 | sessionId not in manager |
| `ProcessDiedError` | -32001 | backend subprocess exited |
| `CancelledError` | -32002 | session cancelled mid-prompt |
| `BackendDriverError` | -32003 | backend SDK failure |
| `AcpTimeoutError` | -32004 | read deadline exceeded |
| `AcpProtocolError` | -32005 | malformed JSON-RPC envelope |

`BackendNotConfiguredError` and `UnknownBackendError` are startup-only (plain Error subclasses); never serialized to the wire.

### `@/index`, env validation entrypoint

`resolveBackendFromEnv(env)` validates `KODIZM_BACKEND` against the allowlist (currently `claude` only).

```ts
import { resolveBackendFromEnv } from '@/index.ts'

const backend = resolveBackendFromEnv(process.env)  // 'claude'
// throws BackendNotConfiguredError when env is missing
// throws UnknownBackendError when value is not in the allowlist
```

### `@/wire/schemas`, canonical request schemas

Six request schemas validate every Kodizm-flavored ACP payload at the wire boundary. All canonical fields (`systemPrompt`, `additionalDirectories`, `mcpServers`, `model`, `skills`, `cwd`) live at the top level; the shared refinement rejects any payload smuggling them through `_meta`.

```ts
import {
  InitializeRequestSchema,
  NewSessionRequestSchema,
  PromptRequestSchema,
  CancelRequestSchema,
  LoadSessionRequestSchema,
  ForkSessionRequestSchema,
} from '@/wire/schemas.ts'

const result = NewSessionRequestSchema.safeParse({
  cwd: '/workspace/auto-mount-test',
  mcpServers: [{ type: 'http', name: 'kodizm', url: 'https://kodizm.com/mcp/internal' }],
  additionalDirectories: ['/data/shared'],
  systemPrompt: { append: 'Always respond in Turkish.' },
  model: 'claude-sonnet-4-6',
  skills: ['my-coding'],
})

if (!result.success) {
  // result.error.issues carries the validation failures
}
```

Type aliases are inferred via `z.infer` and re-exported from `@/wire/types`:

```ts
import type { NewSessionRequest, PromptRequest } from '@/wire/types.ts'
```

`systemPrompt` accepts both `string` (full replacement of the SDK preset) and `{ append: string }` (preset + append) shapes.

### `@/wire/events`, sessionUpdate event union

Discriminated union of every stream event a backend driver may emit during a turn. 13 variants keyed on `type`, all carrying the `sessionId` envelope.

```ts
import { SessionUpdateEventSchema } from '@/wire/events.ts'

const usage = SessionUpdateEventSchema.parse({
  sessionId: 's1',
  type: 'usage',
  inputTokens: 1234,
  outputTokens: 567,
  cacheReadTokens: 8000,
  cacheCreationTokens: 100,
  costUsd: 0.0152,
})
```

| Event type | Carries |
|------------|---------|
| `output_chunk` | `text` (assistant text stream) |
| `thinking_chunk` | `text` (reasoning tokens) |
| `tool_call_begin` | `toolUseId`, `name`, `input` |
| `tool_call_progress` | `toolUseId`, `delta` |
| `tool_call_end` | `toolUseId`, `result`, `isError` |
| `permission_request` | `toolUseId`, `name`, `options[{optionId, label}]` |
| `usage` | 4 token counts + `costUsd` |
| `subagent_spawn` | `childId`, `parentSessionId`, `model`, `tools[]` |
| `subagent_complete` | `childId`, token slice, cost slice |
| `skill_activation` | `skillName`, `source` (`auto` \| `invoked`) |
| `model_advertisement` | `model` |
| `process_died` | `exitCode`, optional `detail` |
| `cancelled` | `reason` |

This union is the SOURCE OF TRUTH across all backends. Phases 2-3 normalize codex / opencode native stream events into this shape via per-backend mappers.

### `@/wire/content`, content blocks

Five content block types for `session/prompt` payloads, mirroring Anthropic's SDK content shapes.

```ts
import { ContentBlockSchema, MAX_INLINE_BASE64_BYTES } from '@/wire/content.ts'

const block = ContentBlockSchema.parse({
  type: 'image',
  source: {
    type: 'base64',
    mediaType: 'image/png',
    data: 'iVBORw0KGgo...',  // < 5MB decoded
  },
})
```

| Block type | Carries |
|------------|---------|
| `text` | `text` |
| `image` | `source: {type: 'base64', mediaType, data} \| {type: 'url', url}` |
| `document` | `source: {...}`, optional `title` |
| `tool_use` | `id`, `name`, `input` |
| `tool_result` | `toolUseId`, `content[{type:'text', text}]`, `isError` |

Inline base64 payloads cap at `MAX_INLINE_BASE64_BYTES` (5MB decoded). Beyond that, use a URL-sourced block backed by external storage.

### `@/backends/driver`, BackendDriver contract

Every backend (Claude phase 1, codex phase 2, opencode phase 3) implements this interface. The dispatcher routes every JSON-RPC method into the matching driver method; capability gating runs before invocation.

```ts
import { type BackendDriver, ensureCapability } from '@/backends/driver.ts'

class MyDriver implements BackendDriver {
  capabilities() {
    return {
      resume: true,
      fork: false,
      fileUpload: true,
      thinking: true,
      subagent: false,
      skillEvents: false,
    }
  }

  async initialize(params) { /* ... */ }
  async newSession(params) { /* ... */ }
  async prompt(sessionId, params, emit) {
    emit.send({ sessionId, type: 'output_chunk', text: 'Hello' })
    return { stopReason: 'end_turn' }
  }
  async cancel(request) { /* ... */ }
  async loadSession(params) { /* ... */ }
  async forkSession(params) { /* ... */ }
}
```

`ensureCapability(caps, required, method)` is the dispatch-layer guard that throws `MethodNotSupportedError` when a driver lacks a feature.

### `@/backends/registry`, env-driven backend registry

`createBackendRegistry()` returns a name -> driver map with env-aware resolution. Phase 1 binds `claude`; phases 2 + 3 add `codex` + `opencode`.

```ts
import { createBackendRegistry } from '@/backends/registry.ts'
import { ClaudeDriver } from '@/backends/claude/driver.ts'

const registry = createBackendRegistry()
registry.register('claude', new ClaudeDriver({ /* ... */ }))

const driver = registry.resolveFromEnv(process.env)
// reads KODIZM_BACKEND, returns the bound driver
// throws BackendNotConfiguredError when env is missing
// throws UnknownBackendError when value is not registered
```

### `@/server/acp-server` with backend wiring

When a backend is passed to `createAcpServer`, the server auto-registers handlers for `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/load`, `session/fork`. Each handler validates the request through the matching wire schema, applies capability gating, and forwards to the driver.

```ts
import { createAcpServer } from '@/server/acp-server.ts'

const server = createAcpServer({ transport, backend })
await server.serve()
// initialize + 5 session/* methods auto-routed to backend
// schema validation failures emit -32602 InvalidParams responses
// capability mismatches emit -32601 with supportedMethods in data
```

The prompt handler wraps `server.notify` into an `EventEmitter`, so driver-emitted `SessionUpdateEvent` values fan out as `sessionUpdate` notifications.

### `@/backends/claude/auth`, credential resolution

`resolveClaudeCredentials(env)` returns a discriminated union of the active credential. Subscription wins over api-key when both are set with `CLAUDE_CODE_REMOTE=1`.

```ts
import { resolveClaudeCredentials } from '@/backends/claude/auth.ts'

const creds = resolveClaudeCredentials(process.env)
// { type: 'subscription' | 'api-key', token: string }
// throws AuthMissingError when neither path is configured
```

### `@/backends/claude/mcp-bridge`, wire -> SDK MCP shape

`translateMcpServers(list)` converts the canonical MCP server array (with explicit `[{name, value}]` headers) into the Claude SDK's name-keyed record (`Record<string, McpHttpServerConfig>`).

```ts
import { translateMcpServers } from '@/backends/claude/mcp-bridge.ts'

const sdkServers = translateMcpServers([
  {
    type: 'http',
    name: 'kodizm',
    url: 'https://kodizm.com/mcp/internal',
    headers: [{ name: 'Authorization', value: 'Bearer kdz-int-jwt.x.y' }],
  },
])
// { kodizm: { type: 'http', url: '...', headers: { Authorization: 'Bearer ...' } } }
```

### `@/backends/claude/driver`, ClaudeDriver class

Implements the full `BackendDriver` contract against an injectable `SdkAdapter`. Production wires `@anthropic-ai/claude-agent-sdk`; tests pass a mock generator.

```ts
import { ClaudeDriver } from '@/backends/claude/driver.ts'
import { resolveClaudeCredentials } from '@/backends/claude/auth.ts'
import { query } from '@anthropic-ai/claude-agent-sdk'

const driver = new ClaudeDriver({
  credentials: resolveClaudeCredentials(process.env),
  agentInfo: { version: '0.0.1' },
  sdk: {
    query: ({ prompt, options }) => query({ prompt, options }),
  },
})

// Plug into AcpServer:
const server = createAcpServer({ transport, backend: driver })
await server.serve()
```

Per-turn model override on `prompt()` does not mutate the stored session options; the next turn without override falls back to the session's bound model.

### `@/backends/claude/event-mapper`, SDK message -> Kodizm event

`mapSdkMessage(sessionId, message)` is a pure function the driver calls per SDK message. It produces zero-or-more Kodizm `SessionUpdateEvent` values:

| SDK message | Emitted Kodizm event(s) |
|-------------|--------------------------|
| `system.init` (with model) | `model_advertisement` |
| `system.init` (with parent_tool_use_id + uuid) | `subagent_spawn` |
| `assistant` text block | `output_chunk` |
| `assistant` thinking block | `thinking_chunk` |
| `assistant` tool_use block | `tool_call_begin` |
| `user` tool_result block | `tool_call_end` |
| `result` (with usage) | `usage` |
| `result` (with parent_tool_use_id) | `subagent_complete` |

Unknown SDK message types fail soft (empty event list) so future SDK extensions do not break the dispatcher.

## Test layering

| Layer | Purpose | Where | Cost |
|-------|---------|-------|------|
| Unit | Per-module contract; SDK mocked | `test/unit/` | free, instant |
| E2E (mocked) | Full ACP roundtrip with fake SDK | `test/e2e/` | free, < 5s |
| Integration (real) | Real Claude / Codex / Opencode API | `test/integration/` | per-run cost; gated on env var presence |

Real-API tests `test.skip(...)` themselves when their auth env is missing, so `bun test` stays green without credentials.

## ACP wire shape

The server speaks a Kodizm-flavored ACP. The shape stays compatible with ACP v1 for `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/load`, `session/fork` but promotes Kodizm-canonical fields (system prompt replace + append, additional directories, MCP servers, model, skills, content blocks for file upload) to top-level instead of `_meta` smuggling. The orchestrator side (Laravel) sends Kodizm-flavored payloads directly; the bridge dispatches to the chosen backend.

Detailed schema lives under `src/wire/` (lands in Wave 2).

## Layout

```
src/
  index.ts                    # bin entrypoint, env validation, server boot
  server/                     # ACP server core
    transport.ts              # NDJSON stdio framing
    acp-server.ts             # JSON-RPC 2.0 dispatch + RPC alias map
    errors.ts                 # typed JsonRpcError subclasses
    lifecycle.ts              # terminator probes + protocol frame validation
  wire/                       # canonical request + event shapes (zod)
    schemas.ts                # 6 request schemas (initialize, new, prompt, cancel, load, fork)
    events.ts                 # 13-variant sessionUpdate event union
    content.ts                # 5 content block types (text/image/document/tool_use/tool_result)
    types.ts                  # z.infer re-exports for compile-time consumption
  backends/                   # per-backend driver + event mapper
    driver.ts                 # BackendDriver contract + ensureCapability gate
    registry.ts               # env-driven name -> driver map
    claude/                   # phase 1
      auth.ts                 # credential resolver (subscription | api-key)
      mcp-bridge.ts           # wire -> SDK MCP record shape
      driver.ts               # ClaudeDriver: BackendDriver implementation
      event-mapper.ts         # SDK message -> Kodizm SessionUpdateEvent
    codex/                    # phase 2
    opencode/                 # phase 3
  session/                    # multi-session manager (Wave 4)
  util/                       # logger, helpers
test/
  unit/                       # mocked SDK
  integration/                # real API, env-gated
  e2e/                        # full pipeline, mocked SDK
```

## License

Apache-2.0.
