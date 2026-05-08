# Changelog

All notable changes to `@kodizm/acp` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.3] - 2026-05-08

### Added

- **`session/compact` JSON-RPC**. New canonical wire RPC mapped per backend onto a manual context-compaction lever. The matching `compaction_started` + `compaction_completed` `sessionUpdate` events both carry `trigger: 'manual'` when compact() drove the compaction (the existing per-backend default tag is still `'auto'`). Schema: `{ jsonrpc: '2.0', id, method: 'session/compact', params: { sessionId: string } }`. Response is an empty object.
- **Claude driver `compact()`**: dispatches the SDK's `/compact` slash command as a synthetic prompt turn through the existing `prompt()` pipeline. Sets a per-session `pendingManualCompact` latch the event-mapper consults to override the started event's trigger ('manual' instead of the default 'auto' the SDK's `system status: compacting` carries).
- **Codex driver `compact()`**: dispatches `thread/compact/start` against the codex subprocess with a per-call `CodexEventMapper` that re-tags the `ContextCompaction` item lifecycle with `trigger: 'manual'`. Awaits the matching `compaction_completed` event before resolving (10s timeout guard).
- **Opencode driver `compact()`**: dispatches `sdk.session.summarize({sessionID, providerID, modelID, auto: false})` with a `pendingManualCompact` latch the OpencodeEventMapper consults via `applyManualCompactLatch` so the persistent SSE-driven `session.compacted` event re-tags `trigger: 'manual'`. Captures `providerID + modelID` at session.create time.

### Changed

- `BackendDriver.compact(request, emit)` is now a required method on every driver. Existing drivers gained the impl; custom drivers MUST add `compact()`. The `emit` parameter exists so compaction events flow through the same `sessionUpdate` notification fan-out as `prompt()` turns.

### Migration notes

- Orchestrator-side: bump `@kodizm/acp` to `0.5.3` and the matching Docker image tag.
- No wire-breaking changes for clients that do NOT call `session/compact`. Clients that try the new RPC against an older driver get `MethodNotSupportedError` with `code: -32601` and a `supportedMethods` list in `data`.

## [0.5.2] - prior

Phase 4 + 5 deferred follow-ups (subagent threading, debug stream, failure heartbeat); see `.ac/plans/acp-failure-heartbeat-debug-stream/` for the corresponding plan.
