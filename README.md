# kodizm-acp

Custom ACP (Agent Client Protocol) server for the Kodizm runtime. One Bun TypeScript binary that drives `@anthropic-ai/claude-agent-sdk` directly, surfaces a Kodizm-flavored canonical wire shape to the orchestrator, and replaces upstream `claude-agent-acp` + `codex-acp` adapters with one maintained codebase.

Status: Phase 1 of 5 complete (bootstrap + Claude backend). Phases 2-5 (codex, opencode, Laravel cutover, image bake) follow.

## Why

The orchestrator (Laravel `app/Services/Project/Acp/`) wants ONE wire shape that exposes every session-runtime feature for every CLI backend: token rollup, model selection, system prompt replace + append, additional directories, MCP server injection, skill injection, file upload, thinking + output + tool streaming, subagent observability, resume + fork. The upstream adapters smuggle most of this through `_meta`. kodizm-acp promotes them to top-level fields and routes each session through one canonical pipeline.

## Install + build

```bash
bun install
bun build src/index.ts --target=bun --outdir=dist
```

## Environment

| Variable | When | Description |
|----------|------|-------------|
| `KODIZM_BACKEND` | always | One of `claude` (phase 1) / `codex` (phase 2) / `opencode` (phase 3). |
| `KODIZM_LOG_LEVEL` | optional | `debug` / `info` / `warn` / `error`. Default `info`. Logs land on stderr. |
| `CLAUDE_CODE_OAUTH_TOKEN` + `CLAUDE_CODE_REMOTE=1` | claude, subscription | Wins over API key when both set. |
| `ANTHROPIC_API_KEY` | claude, api-key fallback | Used when no OAuth token is present. |

Stdout is reserved for ACP frames. Never log to stdout.

## Quick start

The bin reads ACP frames over stdin, drives the chosen backend, and emits `sessionUpdate` notifications for every event.

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' \
  | KODIZM_BACKEND=claude CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-..." CLAUDE_CODE_REMOTE=1 \
    bun run dist/index.js
```

Programmatic embedding (used inside the integration smokes):

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
// result.stopReason === 'end_turn'
// events: [model_advertisement, output_chunk, ..., usage]
```

## Architecture

```
[ orchestrator ]  ──ACP──>  kodizm-acp (Bun TS)  ──> @anthropic-ai/claude-agent-sdk    (Claude)
                                                ──> codex app-server (subprocess)      (Codex)
                                                ──> opencode HTTP server (in-process)  (Opencode)
```

One process per `KODIZM_BACKEND`. Backends are not switchable mid-process. One process serves N concurrent sessions per ACP spec.

```
src/
  index.ts                       # bin entrypoint, env validation, server boot
  server/                        # ACP server core
    transport.ts                 # NDJSON stdio framing
    acp-server.ts                # JSON-RPC 2.0 dispatch, RPC method aliases
    errors.ts                    # typed JsonRpcError subclasses
    lifecycle.ts                 # terminator probes
  wire/                          # Kodizm canonical shapes (zod)
    schemas.ts                   # 6 request schemas
    events.ts                    # 13-variant sessionUpdate event union
    content.ts                   # 5 content block types
  backends/
    driver.ts                    # BackendDriver interface
    registry.ts                  # env-driven driver resolution
    claude/                      # phase 1
      auth.ts                    # OAuth + api-key resolver
      mcp-bridge.ts              # wire -> SDK MCP record
      driver.ts                  # ClaudeDriver: full BackendDriver impl
      event-mapper.ts            # SDK message -> SessionUpdateEvent
      content-mapper.ts          # ContentBlock <-> SDK content block
      subagent.ts                # parent_tool_use_id -> child uuid
  session/
    manager.ts                   # SessionManager
    state.ts                     # SessionState contract
test/
  unit/                          # mocked SDK
  e2e/                           # full ACP roundtrip, mocked SDK
  integration/                   # real API, gated on auth env
```

## API reference

### `createAcpServer({ transport, backend? })`

JSON-RPC 2.0 dispatcher over an NDJSON transport. When a backend is passed, the server auto-registers the six lifecycle methods (`initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/load`, `session/fork`) and routes them to the driver with schema validation + capability gating.

```ts
import { createAcpServer } from '@/server/acp-server.ts'
import { createNdjsonTransport } from '@/server/transport.ts'

const transport = createNdjsonTransport({
  readable: Bun.stdin.stream(),
  writable: new WritableStream({ write: (chunk) => Bun.write(Bun.stdout, chunk) }),
})

const server = createAcpServer({ transport, backend: driver })
await server.serve()
```

The dispatcher fires inbound requests as `void handleRequest(...)` so a long-running prompt never blocks the read loop. Without this, an inbound `session/cancel` could not reach the dispatcher while a prompt was awaiting the SDK stream.

### `RPC_METHOD_ALIASES`

The permission RPC name drifted between SDK drafts (`requestPermission` ↔ `session/request_permission`). Handlers registered under either form route to the same handler bidirectionally.

```ts
import { RPC_METHOD_ALIASES } from '@/server/acp-server.ts'

server.on('session/request_permission', handler)
// Both wire forms hit `handler`.
```

### `BackendDriver`

Every backend implements this interface. Adding codex / opencode does not touch the dispatcher.

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
```

Capability gating runs before driver invocation. A driver that returns `{ resume: false }` causes `session/load` to fail with `MethodNotSupportedError` (-32601, `data.method`, `data.supportedMethods[]`).

### `ClaudeDriver`

Implements `BackendDriver` against `@anthropic-ai/claude-agent-sdk`. Auto-resumes after the first turn so multi-turn conversations preserve the SDK's transcript.

```ts
const { sessionId } = await driver.newSession({
  cwd: '/workspace',
  mcpServers: [
    {
      type: 'http',
      name: 'kodizm',
      url: 'https://kodizm.com/mcp/internal',
      headers: [{ name: 'Authorization', value: 'Bearer kdz-int-jwt.x.y' }],
    },
  ],
  additionalDirectories: ['/data/shared'],
  systemPrompt: { append: 'Always respond in Turkish.' },
  model: 'claude-haiku-4-5-20251001',
  skills: ['my-coding'],
})
```

Per-turn options layer on top of the session's bound options:

```ts
await driver.prompt(
  sessionId,
  { sessionId, prompt: [...], model: 'claude-sonnet-4-6' },
  emit,
)
```

The override applies for one turn; the next turn without override falls back to the session's bound model. Every turn captures the SDK's `session_id` from the first system init message and stores it as `sdkSessionId`; subsequent turns auto-resume from that id.

Cancel propagates through an `AbortController` per turn:

```ts
await driver.cancel({ sessionId })
// emits a synthetic `cancelled` SessionUpdateEvent (reason='user_cancel')
// the prompt() returns with stopReason='cancelled' inside the 5s grace window
```

### `SessionManager`

Multi-session storage. The dispatcher pulls one of these from any backend driver that wants generic session lifecycle.

```ts
import { SessionManager } from '@/session/manager.ts'

const manager = new SessionManager()
const state = manager.create('s1', {
  backend: 'claude',
  sdkOptions: { cwd: '/workspace', mcpServers: {} },
  abortController: new AbortController(),
  parentChildMap: new Map(),
})

manager.has('s1')   // true
manager.get('s1')   // throws SessionNotFoundError on miss
manager.list()      // session ids in insertion order
manager.close('s1') // aborts the controller, then deletes the entry
```

`close()` aborts BEFORE deletion so any in-flight SDK `query()` observes cancellation cleanly.

## Wire shape

### Request schemas (`@/wire/schemas`)

Six zod schemas cover every Kodizm-flavored ACP method. Canonical fields (`systemPrompt`, `additionalDirectories`, `mcpServers`, `model`, `skills`, `cwd`) are top-level. The shared refinement rejects any payload smuggling them through `_meta`.

```ts
import { NewSessionRequestSchema } from '@/wire/schemas.ts'

const result = NewSessionRequestSchema.safeParse({
  cwd: '/workspace',
  mcpServers: [],
  systemPrompt: { append: 'Always respond in Turkish.' },
  model: 'claude-haiku-4-5-20251001',
  skills: ['my-coding'],
})
// result.success === true
```

`AbsolutePathSchema` enforces `/^\//`. `SystemPromptSchema = z.union([z.string(), z.object({ append: z.string() })])`.

### Event union (`@/wire/events`)

Discriminated on `type`. Every variant carries the `sessionId` envelope.

| Event type | Carries |
|------------|---------|
| `output_chunk` | `text` (assistant text stream) |
| `thinking_chunk` | `text` (reasoning tokens) |
| `tool_call_begin` | `toolUseId`, `name`, `input` |
| `tool_call_progress` | `toolUseId`, `delta` |
| `tool_call_end` | `toolUseId`, `result`, `isError` |
| `permission_request` | `toolUseId`, `name`, `options[{optionId, label}]` |
| `usage` | `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd` |
| `subagent_spawn` | `childId`, `parentSessionId`, `model`, `tools[]` |
| `subagent_complete` | `childId`, token slice, cost slice |
| `skill_activation` | `skillName`, `source` (`auto` \| `invoked`) |
| `model_advertisement` | `model` |
| `process_died` | `exitCode`, optional `detail` |
| `cancelled` | `reason` |

### Content blocks (`@/wire/content`)

Five block types for `session/prompt` payloads. Inline base64 caps at 5MB (`MAX_INLINE_BASE64_BYTES`).

| Block type | Carries |
|------------|---------|
| `text` | `text` |
| `image` | `source: {type: 'base64', mediaType, data} \| {type: 'url', url}` |
| `document` | `source: {...}`, optional `title` |
| `tool_use` | `id`, `name`, `input` |
| `tool_result` | `toolUseId`, `content[{type:'text', text}]`, `isError` |

### Error codes (`@/server/errors`)

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

## SDK message → Kodizm event mapping

Pure function `mapSdkMessage(sessionId, message)` translates each SDK stream message:

| SDK message | Emits |
|-------------|-------|
| `system.init` (with `model`) | `model_advertisement` |
| `system.init` (with `skills[]`) | `skill_activation` per name (`source: 'auto'`) |
| `system.init` (with `parent_tool_use_id` + `uuid`) | `subagent_spawn` |
| `assistant` text block | `output_chunk` |
| `assistant` thinking block | `thinking_chunk` |
| `assistant` tool_use (`name: 'Skill'`) | `skill_activation` (`source: 'invoked'`) + `tool_call_begin` |
| `assistant` tool_use (other) | `tool_call_begin` |
| `user` tool_result block | `tool_call_end` |
| `result` (with `usage`) | `usage` |
| `result` (with `parent_tool_use_id`) | `subagent_complete` (childId remapped via `SubagentTracker`) |

Unknown SDK message types fail soft (empty event list).

## Test layering

```bash
bun test                                    # unit + e2e (no auth needed)
bun test test/unit                          # unit only
bun test test/e2e                           # full ACP roundtrip, mocked SDK
bun test test/integration                   # real API, gated on auth env
```

| Layer | Where | Cost | Asserts |
|-------|-------|------|---------|
| Unit | `test/unit/` | free | per-module contract |
| E2E (mocked) | `test/e2e/mocked-pipeline.test.ts` | free | full ACP roundtrip with fake SDK (5 scenarios) |
| Integration (real) | `test/integration/*.smoke.test.ts` | per-run | real API behavior (~5 files) |

Real-API smokes `describe.skipIf(!HAS_AUTH)` themselves when no auth env is configured. Run with subscription:

```bash
CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-..." CLAUDE_CODE_REMOTE=1 \
  bun test test/integration
```

Or with API key:

```bash
ANTHROPIC_API_KEY="sk-ant-..." bun test test/integration
```

Phase 1 close-out: 246 unit + e2e tests passing, 14 integration smokes green against real Claude API (Haiku 4.5 by default).

## Concurrency invariant

`AcpServer` dispatches inbound requests as fire-and-forget microtasks (`void handleRequest(...)`) so a long-running `session/prompt` does not block the read loop. Without this, an inbound `session/cancel` could never reach the dispatcher while a prompt was awaiting the SDK stream — chicken-and-egg deadlock because cancel is what fires the abort that unwinds the prompt.

## License

Apache-2.0.
