/**
 * Opencode `question.asked` -> canonical session/ask_user_question.
 *
 * Phase 3 T7 + locked decision D4. opencode ships a first-class
 * Question.Service plus `tool/question.ts` native question tool. The
 * driver subscribes to `question.asked` bus events, translates each
 * `Question.Info` to canonical `KodizmQuestion`, emits the canonical
 * `question_request` event, sends the outbound
 * `session/ask_user_question` RPC, then maps the orchestrator's
 * answers back to opencode's `Reply.answers: Answer[][]` shape and
 * replies via `sdk.question.reply(requestID, body)`.
 *
 * Mapping (opencode -> canonical):
 *   header  -> truncate to 12 chars (canonical max)
 *   question, options.{label,description} -> direct passthrough
 *   multiple -> multiSelect
 *   custom   -> opencode-only; surfaced via _meta.customByQuestion on
 *               the outbound RPC body so the orchestrator can render
 *               a free-form input alongside the option list
 *
 * Mapping (canonical answer -> opencode):
 *   Orchestrator: { answers: { [questionText]: optionLabel } }
 *   opencode:     { answers: Answer[][] } where Answer = string[]
 *                 (one entry per question, inner array carries
 *                 selected labels; multiSelect splits comma-separated)
 *
 * Cancel path: signal.aborted -> sdk.question.reject(requestID).
 */

import type { KodizmQuestion } from '../../wire/events.ts'
import type { AcpServerLike, EmitLike } from '../claude/permission-bridge.ts'

/**
 * Subset of opencode's `Question.Option` we consume.
 */
export interface OpencodeQuestionOption {
  label: string
  description: string
}

/**
 * Subset of opencode's `Question.Info` we consume. opencode also
 * carries `multiple` + `custom` flags; both pass through.
 */
export interface OpencodeQuestionInfo {
  question: string
  header: string
  options: ReadonlyArray<OpencodeQuestionOption>
  multiple?: boolean
  custom?: boolean
}

/**
 * Subset of opencode's `Question.Request` we consume.
 */
export interface OpencodeQuestionRequest {
  id: string
  sessionID: string
  questions: ReadonlyArray<OpencodeQuestionInfo>
  tool?: { messageID: string; callID: string }
}

interface OrchestratorAskResponse {
  answers?: Record<string, string>
}

/**
 * Minimal opencode SDK surface the handler uses. The driver passes a
 * lightly-typed shape so test fixtures can mock without depending on
 * `OpencodeClient`.
 */
export interface OpencodeQuestionSdk {
  question: {
    reply: (...args: unknown[]) => unknown
    reject: (...args: unknown[]) => unknown
  }
}

/**
 * Handle one opencode question request end-to-end. Returns the
 * orchestrator's responses (raw) so callers can log without
 * re-fetching. The driver normally fires-and-forgets.
 *
 * @returns the orchestrator's answer map, or `{}` on cancel / no
 *          response. Useful for test assertions; production callers
 *          ignore the return.
 */
export async function handleOpencodeQuestion(args: {
  params: OpencodeQuestionRequest
  server: AcpServerLike
  sessionId: string
  sdk: OpencodeQuestionSdk
  emit: EmitLike
  signal: AbortSignal
}): Promise<OrchestratorAskResponse> {
  // 1. Translate opencode questions to canonical KodizmQuestion shape.
  const kodizmQuestions: KodizmQuestion[] = []
  const customByQuestion: Record<string, boolean> = {}

  for (const q of args.params.questions) {
    const opts = q.options.map((o) => ({ label: o.label, description: o.description }))
    if (opts.length < 2 || opts.length > 4) continue

    kodizmQuestions.push({
      question: q.question,
      header: q.header.slice(0, 12),
      options: opts,
      multiSelect: q.multiple ?? false,
    })

    if (q.custom === true) {
      customByQuestion[q.question] = true
    }
  }

  if (kodizmQuestions.length === 0) {
    // No survivable questions; reject so opencode unwinds cleanly.
    await safeReject(args.sdk, args.params.id)
    return { answers: {} }
  }

  // 2. Emit canonical event before the RPC fires (live UI rolls forward).
  args.emit.send({
    sessionId: args.sessionId,
    type: 'question_request',
    toolUseId: args.params.id,
    questions: kodizmQuestions,
  })

  // 3. Outbound RPC + race against the abort signal so cancel paths
  //    fire reject quickly. Cancellation is best-effort: if the
  //    orchestrator never responds, signal must be raised by the
  //    permission timeout / driver lifecycle.
  const rpcBody: Record<string, unknown> = {
    sessionId: args.sessionId,
    toolUseId: args.params.id,
    questions: kodizmQuestions,
  }
  if (Object.keys(customByQuestion).length > 0) {
    rpcBody._meta = { customByQuestion }
  }

  const abortPromise = new Promise<{ aborted: true }>((resolve) => {
    if (args.signal.aborted) {
      resolve({ aborted: true })
      return
    }
    args.signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true })
  })

  const rpcPromise = args.server
    .request<OrchestratorAskResponse>('session/ask_user_question', rpcBody)
    .then((r) => ({ aborted: false as const, response: r }))
    .catch(() => ({ aborted: false as const, response: { answers: {} } as OrchestratorAskResponse }))

  const raceResult = await Promise.race([rpcPromise, abortPromise])

  if ('aborted' in raceResult && raceResult.aborted) {
    await safeReject(args.sdk, args.params.id)
    return { answers: {} }
  }

  const orchestratorResponse = (raceResult as { response: OrchestratorAskResponse }).response
  const orchestratorAnswers = orchestratorResponse.answers ?? {}

  // 4. Build opencode reply: Answer[][] in the SAME order as the
  //    questions array. multiSelect=true splits comma-separated label
  //    strings; single-select wraps the label in a 1-element array.
  const opencodeAnswers: string[][] = kodizmQuestions.map((q) => {
    const raw = orchestratorAnswers[q.question]
    if (raw === undefined || raw.length === 0) return []
    if (q.multiSelect) {
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    }
    return [raw]
  })

  // 5. Reply via opencode SDK. Body shape: `{ answers: Answer[][] }`.
  await safeReply(args.sdk, args.params.id, opencodeAnswers)

  return orchestratorResponse
}

async function safeReply(sdk: OpencodeQuestionSdk, requestId: string, answers: string[][]): Promise<void> {
  try {
    await sdk.question.reply({
      id: requestId,
      body: { answers },
    })
  } catch {
    // Best-effort; opencode logs reply failures on its side.
  }
}

async function safeReject(sdk: OpencodeQuestionSdk, requestId: string): Promise<void> {
  try {
    await sdk.question.reject({ id: requestId })
  } catch {
    // Same best-effort policy.
  }
}
