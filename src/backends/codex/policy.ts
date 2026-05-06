/**
 * Canonical -> codex policy translators.
 *
 * Phase 2 T3 + locked decisions 9-10. The orchestrator passes
 * canonical `permissionMode` (5-value enum) + `toolPolicy` +
 * `additionalDirectories`; this module produces codex's native
 * `AskForApproval` + `SandboxPolicy` shapes for thread/start.
 */

import type { z } from 'zod'
import type { ToolPolicySchema } from '../../wire/schemas.ts'
import type { McpServer } from '../../wire/types.ts'

type CanonicalPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions'

/**
 * Codex `AskForApproval` wire string. The `kebab-case` serde rename
 * matches `references/codex/codex-rs/app-server-protocol/src/protocol/v2/shared.rs`.
 */
export type CodexAskForApproval = 'untrusted' | 'on-failure' | 'on-request' | 'never' | 'granular'

/**
 * Map canonical permissionMode to codex AskForApproval (locked
 * decision 9). plan-mode pairs with ReadOnly sandbox via
 * {@link buildSandboxPolicy}; the approval policy alone is the same
 * `untrusted` value.
 */
export function mapPermissionMode(mode: CanonicalPermissionMode): CodexAskForApproval {
  switch (mode) {
    case 'default':
      return 'untrusted'
    case 'acceptEdits':
      return 'on-failure'
    case 'plan':
      // Codex has no exact plan mode; pair UnlessTrusted (everything
      // asks) with ReadOnly sandbox so writes are blocked at sandbox
      // layer.
      return 'untrusted'
    case 'dontAsk':
      return 'on-request'
    case 'bypassPermissions':
      return 'never'
  }
}

/**
 * Codex sandbox policy shape (matches v2/shared.rs::SandboxPolicy).
 */
export type CodexSandboxPolicy =
  | { mode: 'danger-full-access' }
  | { mode: 'read-only'; network_access: boolean }
  | { mode: 'workspace-write'; writable_roots: string[]; network_access: boolean }
  | { mode: 'external-sandbox'; network_access: boolean }

/**
 * Build the codex `SandboxPolicy` from the canonical session config.
 * Locked decision 10: cwd + additionalDirectories extend
 * writable_roots; bypassPermissions short-circuits to DangerFullAccess;
 * plan mode pins ReadOnly.
 */
export function buildSandboxPolicy(args: {
  cwd: string
  mode: CanonicalPermissionMode
  additionalDirectories?: ReadonlyArray<string>
}): CodexSandboxPolicy {
  if (args.mode === 'bypassPermissions') {
    return { mode: 'danger-full-access' }
  }
  if (args.mode === 'plan') {
    return { mode: 'read-only', network_access: false }
  }
  return {
    mode: 'workspace-write',
    writable_roots: [args.cwd, ...(args.additionalDirectories ?? [])],
    network_access: false,
  }
}

/**
 * Translate canonical toolPolicy.allow / deny / ask patterns to a
 * codex-friendly hint structure. Phase 2 starts with passthrough;
 * Phase 4 cutover may extend with codex-specific permission profiles.
 */
export type CanonicalToolPolicy = z.infer<typeof ToolPolicySchema>

/**
 * Re-export McpServer type for the config mapper's signature.
 */
export type { McpServer }
