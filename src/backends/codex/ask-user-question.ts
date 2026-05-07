/**
 * Codex `item/tool/requestUserInput` -> canonical session/ask_user_question.
 *
 * Codex's experimental requestUserInput RPC is the equivalent of
 * Claude's `AskUserQuestion` tool: the model asks the user a series
 * of questions, the orchestrator collects answers, the model receives
 * them back and continues. The driver collapses both backends onto
 * one canonical wire RPC (`session/ask_user_question`) carrying
 * KodizmQuestion rows so the orchestrator never sees backend specifics.
 *
 * Codex schema (`v2/ToolRequestUserInputParams.ts`):
 *   ToolRequestUserInputParams = { threadId, turnId, itemId, questions[] }
 *   ToolRequestUserInputQuestion = {
 *     id, header, question, isOther, isSecret, options | null
 *   }
 *   ToolRequestUserInputOption = { label, description }
 *   ToolRequestUserInputResponse = { answers: { [id]: { answers: string[] } } }
 *
 * Canonical Kodizm shape (`KodizmQuestion`):
 *   { question, header, options[{label, description, preview?}], multiSelect }
 *
 * Mapping rules (codex -> canonical):
 *   - `id`         -> tracked locally to back-map answers
 *   - `header`     -> truncated to 12 chars (canonical max)
 *   - `question`   -> question
 *   - `options`    -> options (codex `null` or empty/oversize gets
 *                     skipped; canonical requires 2-4)
 *   - `multiSelect`: always false (codex single-answer)
 *
 * Mapping rules (canonical answer -> codex):
 *   - Orchestrator response: `{ answers: { [questionText]: optionLabel } }`
 *   - We back-map questionText -> codex `id` and wrap as
 *     `{ answers: { [id]: { answers: [optionLabel] } } }`.
 */

import type { KodizmQuestion } from '../../wire/events.ts'
import type { AcpServerLike, EmitLike } from '../claude/permission-bridge.ts'

interface CodexQuestionOption {
  label: string
  description: string
}

interface CodexQuestion {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: ReadonlyArray<CodexQuestionOption> | null
}

export interface CodexRequestUserInputParams {
  threadId?: string
  turnId?: string
  itemId: string
  questions: ReadonlyArray<CodexQuestion>
}

interface CodexAnswer {
  answers: ReadonlyArray<string>
}

export interface CodexRequestUserInputResponse {
  answers: Record<string, CodexAnswer>
}

interface OrchestratorAskResponse {
  answers?: Record<string, string>
}

/**
 * Translate one codex requestUserInput RPC into the canonical wire
 * flow. Emits `question_request` event + sends outbound
 * `session/ask_user_question` RPC + back-maps answers to codex shape.
 *
 * If no codex question survives the canonical mapping (all options
 * lists missing or out of 2-4 range), returns an empty answers map
 * so codex unwinds the requestUserInput cleanly.
 */
export async function handleCodexRequestUserInput(args: {
  params: CodexRequestUserInputParams
  server: AcpServerLike
  sessionId: string
  emit: EmitLike
  signal: AbortSignal
}): Promise<CodexRequestUserInputResponse> {
  const kodizmQuestions: KodizmQuestion[] = []
  const idByQuestionText: Record<string, string> = {}

  for (const q of args.params.questions) {
    if (q.options === null) continue
    if (q.options.length < 2 || q.options.length > 4) continue
    const opts = q.options.map((o) => ({ label: o.label, description: o.description }))
    kodizmQuestions.push({
      question: q.question,
      header: q.header.slice(0, 12),
      options: opts,
      multiSelect: false,
    })
    idByQuestionText[q.question] = q.id
  }

  if (kodizmQuestions.length === 0) {
    return { answers: {} }
  }

  // 1. Emit canonical event before the RPC fires (live UI rolls forward).
  args.emit.send({
    sessionId: args.sessionId,
    type: 'question_request',
    toolUseId: args.params.itemId,
    questions: kodizmQuestions,
  })

  // 2. Outbound RPC to the orchestrator. Cancellation is best-effort:
  //    if the abort signal fires we return an empty answers map.
  let response: OrchestratorAskResponse | undefined
  try {
    response = await args.server.request<OrchestratorAskResponse>('session/ask_user_question', {
      sessionId: args.sessionId,
      toolUseId: args.params.itemId,
      questions: kodizmQuestions,
    })
  } catch {
    return { answers: {} }
  }

  if (args.signal.aborted) {
    return { answers: {} }
  }

  // 3. Back-map orchestrator answers -> codex answer shape.
  const codexAnswers: Record<string, CodexAnswer> = {}
  const orchestratorAnswers = response?.answers ?? {}
  for (const [questionText, optionLabel] of Object.entries(orchestratorAnswers)) {
    const id = idByQuestionText[questionText]
    if (id === undefined) continue
    codexAnswers[id] = { answers: [optionLabel] }
  }
  return { answers: codexAnswers }
}
