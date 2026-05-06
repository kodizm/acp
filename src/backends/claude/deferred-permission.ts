/**
 * Claude-driver helpers for Pattern B deferred permissions (Phase 1.6).
 *
 * Two seams sit here: (1) the JSONL sentinel writer the Process A
 * driver calls when `permissionDeferTimeoutMs` fires, and (2) the
 * SDK-transcript path resolver. Both are pure I/O so the
 * driver-facing tests stay deterministic.
 *
 * The marker `__KODIZM_PERMISSION_DEFERRED__` is conventional. The
 * orchestrator's audit pipeline filters or relabels rows carrying
 * this content as "deferred placeholder" rather than user-typed text.
 */

import { appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Sentinel content written into the synthetic tool_result row when a
 * permission is deferred. The orchestrator's audit pipeline filters
 * this value out (it is NOT user-typed text).
 */
export const DEFERRED_PERMISSION_MARKER = '__KODIZM_PERMISSION_DEFERRED__'

/**
 * Resolve the SDK's session JSONL path for a given cwd + sessionId.
 *
 * The SDK persists each session under
 * `<configHome>/projects/<sanitized-cwd>/<sessionId>.jsonl`. The
 * sanitization rule mirrors the SDK's `sanitizePath`: replace every
 * non-alphanumeric character with `-`.
 *
 * @param cwd - the absolute working directory the session was opened in
 * @param sessionId - the SDK's session uuid
 * @param configHome - optional override (defaults to `~/.claude`)
 * @returns absolute path to the session's JSONL file
 */
export function findSessionJsonlPath(cwd: string, sessionId: string, configHome?: string): string {
  const base = configHome ?? join(homedir(), '.claude')
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  return join(base, 'projects', sanitized, `${sessionId}.jsonl`)
}

/**
 * Append a synthetic tool_result row to the SDK's session JSONL.
 *
 * The shape mirrors the row the SDK itself writes when a tool_result
 * is delivered, except `content` carries the {@link DEFERRED_PERMISSION_MARKER}
 * sentinel. Process B's resume flow recognises this marker as the
 * trigger for the cached-answer path.
 *
 * @param jsonlPath - absolute path to the session's JSONL file
 * @param toolUseId - SDK tool_use id of the original deferred call
 * @returns Promise that resolves once the append has flushed
 */
export async function writeDeferredToolResult(jsonlPath: string, toolUseId: string): Promise<void> {
  const row = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: DEFERRED_PERMISSION_MARKER,
          is_error: false,
        },
      ],
    },
  }
  await appendFile(jsonlPath, `${JSON.stringify(row)}\n`)
}
