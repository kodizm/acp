# kodizm-acp

Package-scoped overlay. Parent `kodizm.com` CLAUDE.md + `my-coding` skill cover everything else; only project-specific facts live here.

## Commands

| Command | Purpose |
|---------|---------|
| `bun test test/unit` | unit suite (mocked SDK) |
| `bun test test/e2e` | full ACP roundtrip, mocked SDK |
| `bun test test/integration` | real-API smoke, gated on `ANTHROPIC_API_KEY` |
| `bunx tsc --noEmit` | typecheck (Bundler resolution, `@/` alias) |
| `bunx biome check --write src test` | lint + format with auto-fix |

## Architecture invariants

- One process per `KODIZM_BACKEND` value. Backend selection is spawn-time; not switchable mid-process.
- All backends implement `BackendDriver` (`src/backends/driver.ts`). Adding codex/opencode (phases 2-3) does not touch `AcpServer`.
- Kodizm canonical wire shape (`src/wire/`) is authoritative for orchestrator-facing fields (`systemPrompt`, `additionalDirectories`, `mcpServers`, `model`, `skills`, content blocks). Backends translate down. NEVER smuggle Kodizm fields through `_meta` on the orchestrator edge.

## Gotchas

- **Stdout is reserved for ACP frames.** A single `console.log` corrupts the JSON-RPC stream and kills the session. Use `createLogger` from `@/util/logger` (stderr-only).
- Biome inlines short JSON arrays in config files (`package.json`, `biome.json`). My-coding's "always multi-line" rule applies to source code; accept biome's reformat for JSON.
- Path alias `@/` resolves to `src/` from `test/` only. Inside `src/`, use relative imports with `.ts` extension (`allowImportingTsExtensions: true` in tsconfig).
- Bun's `bun:test` is jest-compatible. Mocks via `mock(fn)`. No `vitest`, no `jest`.

## Submodule workflow

- Lives at `packages/kodizm-acp/` in parent kodizm.com as git submodule (`git@github.com:kodizm/acp.git`).
- Per-task commits push to `kodizm/acp` main directly. Parent submodule pointer bumps at phase end.
- Plans live in parent at `.ac/plans/kodizm-acp/`; don't duplicate planning notes inside the submodule.
