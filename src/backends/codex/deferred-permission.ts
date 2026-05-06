/**
 * Codex Pattern B (deferred-permission) helpers.
 *
 * Phase 2 T11 + locked decision 4. When the orchestrator does not
 * answer a codex approval RPC by `permissionDeferTimeoutMs`, the
 * driver:
 *   1. Locates the codex transcript JSONL via {@link findCodexJsonlPath}.
 *   2. Appends a RolloutItem sentinel via {@link writeDeferredRolloutItem}.
 *   3. Persists deferred state via DeferredPermissionStore (or RPC fallback).
 *   4. Emits canonical `permission_deferred` event.
 *   5. Returns the codex `Decline` decision (with `interrupt`-equivalent
 *      semantics) so codex unwinds the turn.
 * Process B (resume container):
 *   1. Loads deferred state from store.
 *   2. Spawns fresh codex subprocess.
 *   3. `thread/resume { path: codexJsonlPath }` reads the modified
 *      JSONL directly (bypasses ID lookup).
 *   4. Driver re-prompts the model with retry prefix; codex re-issues
 *      the deferred tool; canUseTool wrapper fires the cached answer.
 */

import { appendFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Sentinel content written into the synthetic RolloutItem when a
 * codex permission is deferred. The orchestrator's audit pipeline
 * filters this value out (it is NOT actual tool output).
 */
export const CODEX_DEFERRED_PERMISSION_MARKER = '__KODIZM_PERMISSION_DEFERRED__'

/**
 * Glob `<codexHome>/sessions/rollout-*-<threadId>.jsonl` and return
 * the first match. Codex names rollout files with an RFC3339
 * timestamp prefix + UUID suffix.
 *
 * @param codexHome - the resolved codex home dir (typically `~/.codex`)
 * @param threadId - the codex thread UUID
 * @returns absolute path or null when no match exists
 */
export async function findCodexJsonlPath(codexHome: string, threadId: string): Promise<string | null> {
  const sessionsDir = join(codexHome, 'sessions')
  let entries: string[]
  try {
    entries = await readdir(sessionsDir)
  } catch {
    return null
  }
  const suffix = `-${threadId}.jsonl`
  for (const entry of entries) {
    if (entry.startsWith('rollout-') && entry.endsWith(suffix)) {
      return join(sessionsDir, entry)
    }
  }
  return null
}

/**
 * Append a synthetic RolloutItem to the codex transcript JSONL
 * carrying the {@link CODEX_DEFERRED_PERMISSION_MARKER} sentinel.
 *
 * The shape mirrors codex's own `event_msg` rollout entries; the
 * `tool_call_completed` payload type is the closest match for a
 * resolved tool result that the resume container can re-process.
 */
export async function writeDeferredRolloutItem(jsonlPath: string, callId: string): Promise<void> {
  const row = {
    type: 'event_msg',
    payload: {
      type: 'tool_call_completed',
      call_id: callId,
      result: CODEX_DEFERRED_PERMISSION_MARKER,
    },
  }
  await appendFile(jsonlPath, `${JSON.stringify(row)}\n`)
}
