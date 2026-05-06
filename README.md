# kodizm-acp

Custom ACP (Agent Client Protocol) server for the Kodizm runtime. One Bun TypeScript binary that drives `@anthropic-ai/claude-agent-sdk` directly, surfaces a Kodizm-flavored canonical wire shape to the orchestrator, and replaces upstream `claude-agent-acp` + `codex-acp` adapters with one maintained codebase.

Status: Phase 1 + 1.5 + 1.6 complete (bootstrap + Claude backend + permission/policy/AskUserQuestion/compaction + Pattern B deferred-permission lifecycle). Phases 2-5 (codex, opencode, Laravel cutover, image bake) follow.

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

server.on('session/request_permission', handler)        // also matches: requestPermission
server.on('session/ask_user_question', askHandler)      // also matches: askUserQuestion
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

Six zod schemas cover every Kodizm-flavored ACP method. Canonical fields (`systemPrompt`, `additionalDirectories`, `mcpServers`, `model`, `skills`, `cwd`, `toolPolicy`, `autoCompact`, `permissionTimeoutMs`, `permissionDeferTimeoutMs`) are top-level. The shared refinement rejects any payload smuggling them through `_meta`. `permissionTimeoutMs` and `permissionDeferTimeoutMs` are mutually exclusive (hard-deny mode vs. soft-defer mode).

```ts
import { NewSessionRequestSchema } from '@/wire/schemas.ts'

const result = NewSessionRequestSchema.safeParse({
  cwd: '/workspace',
  mcpServers: [],
  systemPrompt: { append: 'Always respond in Turkish.' },
  model: 'claude-haiku-4-5-20251001',
  skills: ['my-coding'],
  toolPolicy: {
    allow: ['Read', 'Glob', 'Grep', 'Bash:git commit*'],
    deny: ['Bash:git push*'],
    defaultMode: 'dontAsk',
  },
  autoCompact: false,
  permissionTimeoutMs: 30_000,
})
// result.success === true
```

`AbsolutePathSchema` enforces `/^\//`. `SystemPromptSchema = z.union([z.string(), z.object({ append: z.string() })])`.

### Tool policy grammar (`@/wire/policy`)

Canonical `<ToolName>:<pattern>` strings. Backend drivers translate to native CLI grammar. Examples:

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

### Permission flow (`@/backends/claude/permission-bridge`)

Driver wires SDK `canUseTool` to outbound `session/request_permission` RPC + parallel `permission_request` stream event. Default mode is `bypassPermissions` (Kodizm sandboxed Project containers); orchestrator opts in to lower modes.

```ts
import { buildCanUseTool } from '@/backends/claude/permission-bridge.ts'

const canUseTool = buildCanUseTool({
  server,
  sessionId: 's1',
  emit,
  signal: abortController.signal,
  permissionTimeoutMs: 30_000, // optional deadline
})
// Pass to SDK options.canUseTool
```

Outcomes:
- `selected.allow` → `{ behavior: 'allow', updatedInput }`
- `selected.allow_always` → `{ behavior: 'allow', updatedInput, updatedPermissions: [...session-scope rule] }`
- `selected.reject` (or any other) → `{ behavior: 'deny', message: 'User refused permission to run tool' }`
- `cancelled` → throws `Tool use aborted` (SDK absorbs as deny+abort)
- `AcpTimeoutError` (deadline elapsed) → `{ behavior: 'deny', message: 'Permission RPC timed out' }`

Subagent calls carry `agentId` + `parentSessionId` on both the RPC payload and the stream event.

### Deferred permission, Pattern B (`@/backends/claude/deferred-permission`)

When the orchestrator cannot answer a permission within seconds (10-day-class operator workflow), the driver writes a synthetic tool_result row to the SDK transcript, persists deferred state to the orchestrator side, emits `permission_deferred`, then exits gracefully. Hours later, a fresh container resumes the session, replays the JSONL, and continues with the cached answer.

Opt in per session via `permissionDeferTimeoutMs`. Mutually exclusive with `permissionTimeoutMs` (hard-deny mode). When neither is set, the driver waits forever on the abort signal (legacy Phase 1.5 behavior).

```ts
const { sessionId } = await driver.newSession({
  cwd: '/workspace',
  mcpServers: [],
  toolPolicy: { defaultMode: 'default' },
  permissionDeferTimeoutMs: 1_800_000, // 30 min before defer fires
})
```

Process A (defer cycle):

```ts
// Inside the driver, on defer-racer winning:
//   1. writeDeferredToolResult(jsonlPath, toolUseId)        // synthetic JSONL row
//   2. deferredStore.set(sessionId, { toolUseId, ...input }) // state persistence
//   3. emit { type: 'permission_deferred', sessionId, toolUseId, name }
//   4. canUseTool returns { behavior: 'deny', interrupt: true } (SDK unwinds)
```

Process B (resume cycle):

```ts
// On the resume container's first prompt:
//   1. one-shot deferredStore.get(sessionId) lookup
//   2. retry prefix injected: "User has answered the deferred permission: <decision>. ..."
//   3. canUseTool wrap fires the cached answer for the matching toolUseId
//   4. emit { type: 'permission_resumed', sessionId, toolUseId, decision }
//   5. deferredStore.delete(sessionId) (one-shot consumption)
```

Marker `__KODIZM_PERMISSION_DEFERRED__` flags rows the orchestrator's audit pipeline must filter or relabel as "deferred placeholder".

State store contract (in-memory binding ships in Phase 1.6; production Laravel-DB binding lands in Phase 4):

```ts
import { type DeferredPermissionStore, InMemoryDeferredStore } from '@/session/deferred-store.ts'

const store = new InMemoryDeferredStore()
const driver = new ClaudeDriver({
  credentials,
  agentInfo: { version: '0.0.1' },
  sdk,
  server,
  deferredStore: store, // optional; outbound RPC fallback fires when omitted
})
```

When `deferredStore` is omitted, the driver issues outbound `session/permission_deferred_persist` RPC on Process A and `session/permission_deferred_state` RPC on Process B (the production path: orchestrator handles persistence).

### AskUserQuestion (`@/backends/claude/ask-user-question`)

Dedicated outbound `session/ask_user_question` RPC for the SDK's `AskUserQuestion` tool. Driver chains it BEFORE the generic permission flow:

```ts
const ask = askUserQuestionBranch({ server, sessionId, emit, signal })
const gate = buildCanUseTool({ server, sessionId, emit, signal })

canUseTool = async (toolName, input, opts) => {
  const askResult = await ask(toolName, input, opts)
  if (askResult !== null) return askResult
  return await gate(toolName, input, opts)
}
```

Wire RPC payload:
```ts
{
  sessionId: 's1',
  toolUseId: 'tu_1',
  agentId?: 'sub_outer',
  questions: [
    {
      question: 'Pick one color: red or blue?',
      header: 'Color',          // ≤12 chars
      options: [
        { label: 'red',  description: 'Warm tone' },
        { label: 'blue', description: 'Cool tone' },
      ],
      multiSelect: false,
    },
  ],
}
```

Response: `{ answers: { '<question text>': '<answer>' }, annotations? }`. Multi-select answers comma-joined.

### Compaction observability (`@/backends/claude/event-mapper`)

SDK conversation compaction surfaces as two stream events. Compaction can be opt-out via `autoCompact: false` in `NewSessionRequest` (driver injects `DISABLE_AUTO_COMPACT=1` env).

```ts
{ type: 'compaction_started',  sessionId, trigger: 'manual' | 'auto' }
{ type: 'compaction_completed',
  sessionId,
  trigger,
  preTokens: 78000,
  postTokens?: 12000,
  durationMs?: 1500,
  succeeded: true,
  error?: 'prompt_too_long retry exhausted' }
```

Compaction CANNOT be vetoed (SDK constraint). `PreCompact` hook can only inject custom summary instructions; the operation always proceeds. Pre-compaction stream events stay valid history; orchestrator UI renders a "history compressed" marker with token deltas.

### Event union (`@/wire/events`)

Discriminated on `type`. Every variant carries the `sessionId` envelope.

| Event type | Carries |
|------------|---------|
| `output_chunk` | `text` (assistant text stream) |
| `thinking_chunk` | `text` (reasoning tokens) |
| `tool_call_begin` | `toolUseId`, `name`, `input` |
| `tool_call_progress` | `toolUseId`, `delta` |
| `tool_call_end` | `toolUseId`, `result`, `isError` |
| `permission_request` | `toolUseId`, `name`, `options[{optionId, label}]`, `agentId?`, `parentSessionId?` |
| `permission_deferred` | `toolUseId`, `name`, `agentId?` |
| `permission_resumed` | `toolUseId`, `decision: 'allow' \| 'deny'` |
| `question_request` | `toolUseId`, `questions: KodizmQuestion[]`, `agentId?`, `parentSessionId?` |
| `usage` | `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd` |
| `subagent_spawn` | `childId`, `parentSessionId`, `model`, `tools[]` |
| `subagent_complete` | `childId`, token slice, cost slice |
| `skill_activation` | `skillName`, `source` (`auto` \| `invoked`) |
| `model_advertisement` | `model` |
| `process_died` | `exitCode`, optional `detail` |
| `cancelled` | `reason` |
| `compaction_started` | `trigger: 'manual' \| 'auto'` |
| `compaction_completed` | `trigger`, `preTokens`, `postTokens?`, `durationMs?`, `succeeded`, `error?` |

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

Phase 1 + 1.5 + 1.6 close-out: 361 unit + e2e tests passing, 24 integration smokes green against real Claude API (Sonnet 4.6 + Haiku 4.5 mix). Total suite: ~365 tests across ~46 files.

## Concurrency invariant

`AcpServer` dispatches inbound requests as fire-and-forget microtasks (`void handleRequest(...)`) so a long-running `session/prompt` does not block the read loop. Without this, an inbound `session/cancel` could never reach the dispatcher while a prompt was awaiting the SDK stream — chicken-and-egg deadlock because cancel is what fires the abort that unwinds the prompt.

## License

Apache-2.0.
