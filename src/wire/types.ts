/**
 * TS types inferred from the canonical wire schemas.
 *
 * Callers should import the type aliases from this file rather than
 * threading `z.infer<typeof Schema>` through every signature. The
 * schemas remain the source of truth at runtime; these aliases are
 * the source of truth at compile time.
 */

import type { z } from 'zod'

import type {
  CancelRequestSchema,
  CompactSessionRequestSchema,
  ForkSessionRequestSchema,
  InitializeRequestSchema,
  LoadSessionRequestSchema,
  McpServerSchema,
  NewSessionRequestSchema,
  PromptRequestSchema,
} from './schemas.ts'

export type McpServer = z.infer<typeof McpServerSchema>
export type InitializeRequest = z.infer<typeof InitializeRequestSchema>
export type NewSessionRequest = z.infer<typeof NewSessionRequestSchema>
export type PromptRequest = z.infer<typeof PromptRequestSchema>
export type CancelRequest = z.infer<typeof CancelRequestSchema>
export type LoadSessionRequest = z.infer<typeof LoadSessionRequestSchema>
export type ForkSessionRequest = z.infer<typeof ForkSessionRequestSchema>
export type CompactSessionRequest = z.infer<typeof CompactSessionRequestSchema>
