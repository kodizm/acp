/**
 * Subagent observability tracker for the Claude SDK driver.
 *
 * The SDK signals subagent lifecycle through two cross-message links:
 *   - On spawn: a `system init` message carries `parent_tool_use_id`
 *     (the Task tool invocation that spawned the child) AND `uuid`
 *     (the child's own session identifier).
 *   - On complete: a `result` message carries the same
 *     `parent_tool_use_id` but no longer the child uuid.
 *
 * The pure {@link mapSdkMessage} function fills the subagent_complete
 * event's `childId` from `parent_tool_use_id` because that is what the
 * SDK exposes per-message; the orchestrator however wants the stable
 * child session id (uuid). This tracker holds the
 * `parent_tool_use_id -> uuid` map across messages and rewrites the
 * complete events on the way out.
 *
 * Lifecycle: one tracker per turn. Subagent invocations live within a
 * single Task tool call and do not persist across turns; clearing
 * between turns prevents stale mappings.
 *
 * Mirrors Laravel's `SubagentParentResolver` shape so both sides have
 * a parallel mental model.
 */

import type { SessionUpdateEvent } from '../../wire/events.ts'
import type { SdkMessage } from './event-mapper.ts'

/**
 * Stateful map of `parent_tool_use_id -> child session uuid` keyed
 * across all subagent spawns in the current turn.
 */
export class SubagentTracker {
  private readonly toolUseIdToChildId: Map<string, string> = new Map()

  /**
   * Observe a raw SDK message. When it is a system init with both a
   * parent_tool_use_id and a uuid, the link is recorded for later
   * complete-event rewriting.
   *
   * @param message - the raw SDK message to inspect
   */
  public observe(message: SdkMessage): void {
    if (message.type !== 'system' || message.subtype !== 'init') {
      return
    }
    if (message.parent_tool_use_id === undefined || message.uuid === undefined) {
      return
    }
    this.toolUseIdToChildId.set(message.parent_tool_use_id, message.uuid)
  }

  /**
   * Rewrite a list of events emitted for a single SDK message. Each
   * subagent_complete whose `childId` matches a recorded
   * parent_tool_use_id is replaced with the child's stable uuid.
   *
   * Other event types pass through unchanged.
   *
   * @param events - events emitted by {@link mapSdkMessage}
   * @returns events with subagent_complete childIds remapped
   */
  public rewrite(events: SessionUpdateEvent[]): SessionUpdateEvent[] {
    return events.map((event) => {
      if (event.type !== 'subagent_complete') {
        return event
      }
      const resolved = this.toolUseIdToChildId.get(event.childId)
      if (resolved === undefined) {
        return event
      }
      return { ...event, childId: resolved }
    })
  }

  /**
   * Number of recorded spawn -> child mappings. Useful for tests and
   * for surfacing a per-turn subagent count.
   */
  public size(): number {
    return this.toolUseIdToChildId.size
  }

  /**
   * Drop all recorded mappings. Called between turns so a fresh turn
   * starts with no inherited subagent state.
   */
  public clear(): void {
    this.toolUseIdToChildId.clear()
  }
}
