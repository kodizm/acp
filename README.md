# kodizm-acp

Custom ACP (Agent Client Protocol) server for the Kodizm runtime. Bridges Claude Code, codex, and opencode CLIs through a single Kodizm-flavored ACP surface, replacing the upstream `claude-agent-acp` and `codex-agent` adapters with one maintained codebase.

Status: **early development**. Phase 1 of 5 (bootstrap + Claude backend) in progress.

## Roadmap

| Wave | Tasks | Status |
|------|-------|--------|
| 0, bootstrap | T1-T4 | done |
| 1, ACP server core | T5-T9 | done |
| 2, canonical wire shape | T10-T12 | pending |
| 3, backend driver + registry | T13-T15 | pending |
| 4, Claude SDK driver | T16-T20 | pending |
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
  server/                     # ACP server core (transport, dispatch, lifecycle, errors, aliases)
  wire/                       # canonical request + event shapes (zod, Wave 2)
  backends/                   # per-backend driver + event mapper (Wave 3-4)
    claude/                   # phase 1
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
