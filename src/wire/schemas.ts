/**
 * Kodizm canonical wire schemas (zod).
 *
 * The orchestrator (Laravel side) sends Kodizm-flavored ACP requests.
 * Every field the user listed as a "common feature" lives at the top
 * level of the request payload, not smuggled through `_meta`. The
 * `_meta` bag stays a true extension surface (trace ids, opaque
 * passthrough); schemas reject any attempt to put canonical fields
 * inside it so the source of truth never drifts.
 *
 * TS types are inferred via {@link z.infer} and re-exported from
 * `./types.ts` so callers get autocompletion without depending on
 * zod for shape lookup.
 */

import { z } from 'zod'

/**
 * Absolute filesystem path. Relative paths fail; the SDK requires
 * absolute roots and we surface the violation at the wire boundary
 * instead of letting it propagate into the backend driver.
 */
const AbsolutePathSchema = z.string().regex(/^\//, 'path must be absolute (start with "/")')

/**
 * MCP server entry passed inline on `session/new`. Phase 1 supports
 * the `http` transport only; codex / opencode phases may add more
 * (sse, stdio) which extend this discriminator.
 */
export const McpServerSchema = z.object({
  type: z.literal('http'),
  name: z.string().min(1),
  url: z.string().url(),
  headers: z
    .array(
      z.object({
        name: z.string().min(1),
        value: z.string(),
      }),
    )
    .optional(),
})

/**
 * `systemPrompt` accepts two shapes:
 *   - string: full replacement of the SDK's preset prompt
 *   - { append: string }: keep the SDK preset, append our extra
 *
 * The append form maps to claude-agent-sdk's
 * `{ type: 'preset', preset: 'claude_code', append: string }` shape.
 */
const SystemPromptSchema = z.union([
  z.string(),
  z.object({
    append: z.string(),
  }),
])

/**
 * Free-form `_meta` extension bag. Acts as a passthrough for
 * orchestrator-level metadata (trace ids, audit hints) that is not
 * part of the canonical contract. Keys that overlap canonical fields
 * are rejected by the per-request `rejectMetaSmuggling` refinement.
 */
const MetaSchema = z.record(z.string(), z.unknown())

/**
 * Canonical fields that must NOT appear inside `_meta`. Listed once
 * so every request schema enforces the same boundary.
 */
const CANONICAL_FIELDS_BANNED_IN_META = [
  'systemPrompt',
  'additionalDirectories',
  'mcpServers',
  'model',
  'skills',
  'cwd',
  'sessionId',
  'sourceSessionId',
  'toolPolicy',
  'autoCompact',
  'permissionTimeoutMs',
] as const

/**
 * Canonical permissionMode enum mirrors the Claude SDK shape exactly
 * so a translator-free pass-through is possible. Every backend driver
 * is responsible for mapping unsupported modes (codex / opencode may
 * not have all five) to its closest native equivalent.
 */
const PermissionModeSchema = z.enum(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'])

/**
 * Canonical Kodizm tool policy shape. Backend drivers translate the
 * `<ToolName>:<pattern>` strings to their native CLI grammar. See
 * `src/wire/policy.ts` for the parser + `src/backends/<name>/policy.ts`
 * for per-backend translation tables.
 *
 * `defaultMode` controls the SDK's blanket gate. When undefined, the
 * driver applies Kodizm's own default (`bypassPermissions` for the
 * Claude backend; phases 2-3 set their own).
 */
const ToolPolicySchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  ask: z.array(z.string()).optional(),
  defaultMode: PermissionModeSchema.optional(),
})

/**
 * Refinement helper that rejects any payload smuggling a canonical
 * field through `_meta`. Used by every schema that exposes `_meta`.
 *
 * @param data - the parsed request, expected to carry an optional `_meta`
 * @returns true when no canonical key is present in `_meta`
 */
function metaCarriesNoCanonicalFields(data: { _meta?: Record<string, unknown> }): boolean {
  if (data._meta === undefined) {
    return true
  }
  for (const banned of CANONICAL_FIELDS_BANNED_IN_META) {
    if (banned in data._meta) {
      return false
    }
  }
  return true
}

const META_SMUGGLE_MESSAGE =
  'canonical fields (systemPrompt, additionalDirectories, mcpServers, model, skills, cwd) must be top-level, not nested in _meta'

/**
 * `initialize` request: ACP v1 handshake. Carries protocol version +
 * client capabilities. Kodizm extensions land in `_meta`.
 */
export const InitializeRequestSchema = z.object({
  protocolVersion: z.number().int().positive(),
  clientCapabilities: z.record(z.string(), z.unknown()).optional(),
  _meta: MetaSchema.optional(),
})

/**
 * `session/new` request: opens a session against the chosen backend.
 * All Kodizm-specific fields (systemPrompt, additionalDirectories,
 * model, skills) are first-class top-level. Backend drivers translate
 * down to their respective SDK shapes.
 */
export const NewSessionRequestSchema = z
  .object({
    cwd: AbsolutePathSchema,
    mcpServers: z.array(McpServerSchema),
    additionalDirectories: z.array(AbsolutePathSchema).optional(),
    systemPrompt: SystemPromptSchema.optional(),
    model: z.string().optional(),
    skills: z.array(z.string()).optional(),
    toolPolicy: ToolPolicySchema.optional(),
    autoCompact: z.boolean().optional(),
    permissionTimeoutMs: z.number().int().positive().optional(),
    _meta: MetaSchema.optional(),
  })
  .refine(metaCarriesNoCanonicalFields, { message: META_SMUGGLE_MESSAGE, path: ['_meta'] })

/**
 * `session/prompt` request: a turn in an existing session. The
 * `prompt` array carries content blocks (text, image, document,
 * tool_use, tool_result); their full schema lands in T12 alongside
 * the content mapper, so this layer keeps the array element type
 * permissive.
 */
export const PromptRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    prompt: z.array(z.unknown()),
    model: z.string().optional(),
    _meta: MetaSchema.optional(),
  })
  .refine(metaCarriesNoCanonicalFields, { message: META_SMUGGLE_MESSAGE, path: ['_meta'] })

/**
 * `session/cancel` request: orchestrator asks the in-flight prompt to
 * stop. The driver flips `cancelledAt` and the read-loop honors the
 * 2s grace window before raising {@link CancelledError}.
 */
export const CancelRequestSchema = z.object({
  sessionId: z.string().min(1),
})

/**
 * `session/load` request: re-attach to a prior session, replaying its
 * transcript through the SDK's resume mode. Carries the full session
 * options because the backend may have been restarted between calls.
 */
export const LoadSessionRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    cwd: AbsolutePathSchema,
    mcpServers: z.array(McpServerSchema),
    _meta: MetaSchema.optional(),
  })
  .refine(metaCarriesNoCanonicalFields, { message: META_SMUGGLE_MESSAGE, path: ['_meta'] })

/**
 * `session/fork` request: branch an existing session with optional
 * overrides. systemPrompt + model overrides apply to the new branch
 * only; the source session remains untouched.
 */
export const ForkSessionRequestSchema = z
  .object({
    sourceSessionId: z.string().min(1),
    cwd: AbsolutePathSchema,
    mcpServers: z.array(McpServerSchema),
    systemPrompt: SystemPromptSchema.optional(),
    model: z.string().optional(),
    additionalDirectories: z.array(AbsolutePathSchema).optional(),
    _meta: MetaSchema.optional(),
  })
  .refine(metaCarriesNoCanonicalFields, { message: META_SMUGGLE_MESSAGE, path: ['_meta'] })
