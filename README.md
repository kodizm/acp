# kodizm-acp

Custom ACP (Agent Client Protocol) server for the Kodizm runtime. Bridges Claude Code, codex, and opencode CLIs through a single Kodizm-flavored ACP surface, replacing the upstream `claude-agent-acp` and `codex-acp` adapters with one maintained codebase.

Status: **early development**. Phase 1 of 5 (bootstrap + Claude backend) in progress.

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

## Test layering

| Layer | Purpose | Where | Cost |
|-------|---------|-------|------|
| Unit | Per-module contract; SDK mocked | `test/unit/` | free, instant |
| E2E (mocked) | Full ACP roundtrip with fake SDK | `test/e2e/` | free, < 5s |
| Integration (real) | Real Claude / Codex / Opencode API | `test/integration/` | per-run cost; gated on env var presence |

Real-API tests `test.skip(...)` themselves when their auth env is missing, so `bun test` stays green without credentials.

## ACP wire shape

The server speaks a Kodizm-flavored ACP. The shape stays compatible with ACP v1 for `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/load`, `session/fork` but promotes Kodizm-canonical fields (system prompt replace + append, additional directories, MCP servers, model, skills, content blocks for file upload) to top-level instead of `_meta` smuggling. The orchestrator side (Laravel) sends Kodizm-flavored payloads directly; the bridge dispatches to the chosen backend.

Detailed schema lives under `src/wire/`.

## Layout

```
src/
  index.ts                    # bin entrypoint, env validation, server boot
  server/                     # ACP server core (transport, dispatch, lifecycle)
  wire/                       # canonical request + event shapes (zod)
  backends/                   # per-backend driver + event mapper
    claude/                   # phase 1
    codex/                    # phase 2
    opencode/                 # phase 3
  session/                    # multi-session manager
  util/                       # logger, helpers
test/
  unit/                       # mocked SDK
  integration/                # real API, env-gated
  e2e/                        # full pipeline, mocked SDK
```

## License

Apache-2.0.
