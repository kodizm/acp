# CLAUDE.md (package: kodizm-acp)

This file is consumed by Claude Code when an agent works inside this submodule. It is package-scoped; the parent `kodizm.com` repo's `CLAUDE.md` still applies on top.

## Stack

- Bun >= 1.1 runtime + bundler + test runner.
- TypeScript 5.6 with `module: ESNext` + `moduleResolution: Bundler`, strict, verbatimModuleSyntax.
- Biome 1.9 for lint + format. 120 col, single quotes, semicolons asNeeded, trailing commas everywhere.
- Zod 3.25 for runtime schemas at the wire boundary.

## Commands

| Command | Purpose |
|---------|---------|
| `bun test test/unit` | unit suite, fastest |
| `bun test test/unit/<path>` | single test file |
| `bun test test/e2e` | full ACP roundtrip with mocked SDK |
| `bun test:integration` | real-API smoke, gated on env vars |
| `bunx tsc --noEmit` | typecheck only (no emit) |
| `bunx biome check src test` | lint + format check |
| `bunx biome check --write src test` | apply auto-fixes |

## Code style

The parent repo's `my-coding` rules apply. TypeScript-specific reminders:

- Every public function and class has a JSDoc block with `@param`, `@returns`, `@throws` where relevant.
- Type everything; no `any`. Use `unknown` at boundaries, narrow inside.
- Path alias `@/` resolves to `src/`. Use it from `test/`; relative imports inside `src/`.
- Use `import type { ... }` for type-only imports (verbatimModuleSyntax requires it).
- Multi-line collections in source code; Biome inlines short JSON arrays in config files (accept).
- Numbered step comments for any function with 3+ logical phases.
- Stdout is reserved for ACP wire. NEVER `console.log`. Use the `createLogger` helper from `@/util/logger`.

## TDD

Red-green-refactor mandatory. Every feature, bug fix, or refactor starts with a failing test. Bun's test runner (`bun:test`) is jest-compatible; mocks via `mock(...)`.

## Architecture invariants

- One process serves the AcpServer; backend selection is process-spawn time via `KODIZM_BACKEND`.
- Each `BackendDriver` implements the unified contract in `src/backends/driver.ts`. Phase 1 ships `ClaudeDriver`; phases 2-3 add `CodexDriver` and `OpencodeDriver` without touching the AcpServer.
- The Kodizm canonical wire shape is the SOURCE OF TRUTH for fields the orchestrator passes (`systemPrompt`, `additionalDirectories`, `mcpServers`, `model`, `skills`, content blocks). Backends translate down; do not smuggle through `_meta` on the orchestrator-facing edge.

## Submodule + workflow

- This package lives at `packages/kodizm-acp/` in the `kodizm.com` parent repo as a git submodule (`git@github.com:kodizm/acp.git`).
- Per-task commits land here and push to the `main` branch of `kodizm/acp`.
- The parent repo's submodule pointer bumps once per phase end (or sooner if pointer drift causes confusion).
- Plan file lives in the parent at `.ac/plans/kodizm-acp/phase-01-bootstrap-claude.md`; do not duplicate planning notes inside the submodule.
