/**
 * Translate the Kodizm canonical {@link PromptRequest.prompt} (an array
 * of content blocks) into the shape `claude-agent-sdk`'s `query()`
 * actually consumes.
 *
 * The SDK's `prompt` parameter accepts either a plain string OR an
 * `AsyncIterable<SDKUserMessage>` (`sdk.d.ts:2234`). Historically the
 * driver flattened to text and dropped non-text blocks; that path stays
 * as the fast path when the prompt is text-only so legacy callers see
 * byte-identical input. As soon as a single non-text block (image or
 * document) appears, the helper switches to the async-iterable path,
 * yielding exactly one `SDKUserMessage` whose `message.content` is the
 * full ordered `ContentBlockParam[]` produced by the existing mapper.
 *
 * The Pattern B deferred resume prefix (a leading instruction string)
 * is plumbed through both branches: prepended verbatim on the string
 * branch; emitted as a leading `{type:'text'}` block on the iterable
 * branch.
 */

import type { ContentBlock } from '../../wire/content.ts'
import type { PromptRequest } from '../../wire/types.ts'
import { type ClaudeSdkContentBlock, promptBlocksToSdk } from './content-mapper.ts'

/**
 * Structural mirror of the SDK's `SDKUserMessage` shape (sdk.d.ts:3489).
 * Defined locally so this file does not depend on SDK module loading;
 * the production driver passes the value straight through to the SDK
 * which validates structurally.
 */
export interface ClaudeSdkUserMessage {
  type: 'user'
  message: {
    role: 'user'
    content: ClaudeSdkContentBlock[]
  }
  parent_tool_use_id: null
}

/**
 * Build the SDK input value for {@link PromptRequest.prompt}. Returns:
 *
 *   - a `string` when every block is `type:'text'` — joined with `\n`
 *     and prefixed with `resumePrefix` if supplied. This matches the
 *     legacy `serializePrompt` path byte-for-byte.
 *   - an `AsyncIterable<ClaudeSdkUserMessage>` yielding exactly one
 *     `ClaudeSdkUserMessage` whose `message.content` is the ordered
 *     `ContentBlockParam[]` (with `resumePrefix` materialised as a
 *     leading `text` block) when ANY block is non-text.
 */
export function buildClaudePromptInput(
  params: PromptRequest,
  resumePrefix?: string,
): string | AsyncIterable<ClaudeSdkUserMessage> {
  // The wire schema keeps `prompt` permissive (`z.array(z.unknown())`).
  // The driver's contract is that the orchestrator only ever sends
  // canonical content blocks; cast to ContentBlock[] for the typed
  // mapper while keeping the runtime narrowing on `type === 'text'`.
  const blocks = params.prompt as ContentBlock[]

  if (blocks.every((b) => b.type === 'text')) {
    const joined = (blocks as Array<{ type: 'text'; text: string }>).map((b) => b.text).join('\n')
    return resumePrefix === undefined ? joined : `${resumePrefix}${joined}`
  }

  const sdkBlocks = promptBlocksToSdk(blocks)
  const content: ClaudeSdkContentBlock[] =
    resumePrefix === undefined ? sdkBlocks : [{ type: 'text', text: resumePrefix }, ...sdkBlocks]

  const message: ClaudeSdkUserMessage = {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  }

  return singleMessageIterable(message)
}

function singleMessageIterable(message: ClaudeSdkUserMessage): AsyncIterable<ClaudeSdkUserMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkUserMessage> {
      let yielded = false
      return {
        async next(): Promise<IteratorResult<ClaudeSdkUserMessage>> {
          if (yielded) {
            return { value: undefined, done: true }
          }
          yielded = true
          return { value: message, done: false }
        },
      }
    },
  }
}
