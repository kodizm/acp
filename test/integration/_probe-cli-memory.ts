/**
 * Manual probe (NOT a bun:test suite). Underscore prefix excludes it from `bun test`.
 *
 * Run from package dir:
 *   cd packages/kodizm-acp && \
 *     CLAUDE_CODE_OAUTH_TOKEN=... CLAUDE_CODE_REMOTE=1 \
 *     bun run test/integration/_probe-cli-memory.ts
 *
 * Question under test: does the kodizm-acp driver preserve the Claude Code CLI's
 * default memory-loading behaviour (CLAUDE.md + .claude/rules + AGENTS.md) when
 * the orchestrator does not pass an explicit settingSources / cwd override?
 *
 * Workspace prepared by caller at /tmp/kdz-acp-probe-ws:
 *   CLAUDE.md, AGENTS.md  -> PIZZA_CODE_GAMMA = 4242
 *   .claude/rules/secret.md -> ZEBRA_TOKEN = 9988
 */

import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ClaudeCredentials } from '@/backends/claude/auth.ts'
import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'
import type { EventEmitter } from '@/backends/driver.ts'
import { OpencodeDriver } from '@/backends/opencode/driver.ts'
import type { SessionUpdateEvent } from '@/wire/events.ts'

const WS = '/tmp/kdz-acp-probe-ws'
const PROMPT_PIZZA =
  'According to the project instructions you were given, what is the value of PIZZA_CODE_GAMMA? Reply with the number only, nothing else.'
const PROMPT_ZEBRA =
  'According to your project rules, what is the value of ZEBRA_TOKEN? Reply with the number only, nothing else.'

function pickClaudeCreds(): ClaudeCredentials {
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''
  if (oauth.length > 0) return { type: 'subscription', token: oauth }
  return { type: 'api-key', token: process.env.ANTHROPIC_API_KEY ?? '' }
}

function recorder(): { events: SessionUpdateEvent[]; emit: EventEmitter } {
  const events: SessionUpdateEvent[] = []
  return { events, emit: { send: (e) => events.push(e) } }
}

function joinOutput(events: SessionUpdateEvent[]): string {
  return events
    .filter((e) => e.type === 'output_chunk')
    .map((e) => (e.type === 'output_chunk' ? e.text : ''))
    .join('')
}

function toolCalls(events: SessionUpdateEvent[]): string[] {
  return events
    .filter((e): e is Extract<SessionUpdateEvent, { type: 'tool_call_begin' }> => e.type === 'tool_call_begin')
    .map((e) => e.name)
}

async function runClaudeVariant(
  overrideSettingSources: 'omit' | 'empty' | 'project' | 'all',
  prompt: string,
): Promise<{ output: string; tools: string[]; threw?: string }> {
  const sdkMod = await import('@anthropic-ai/claude-agent-sdk')
  const adapter: SdkAdapter = {
    async *query(args) {
      const opts = { ...(args.options as Record<string, unknown>) }
      if (overrideSettingSources === 'empty') opts.settingSources = []
      else if (overrideSettingSources === 'project') opts.settingSources = ['project']
      else if (overrideSettingSources === 'all') opts.settingSources = ['user', 'project', 'local']
      // Disable every read-y tool so the only source of an answer is what the
      // SDK preloaded into the system prompt. Without this, the model may
      // satisfy the prompt by calling Read/Grep/Glob on CLAUDE.md itself.
      opts.disallowedTools = [
        'Read',
        'Glob',
        'Grep',
        'LS',
        'Bash',
        'WebFetch',
        'WebSearch',
        'Task',
        'TodoWrite',
        'NotebookRead',
      ]
      for await (const msg of sdkMod.query({ prompt: args.prompt as never, options: opts as never })) {
        yield msg as never
      }
    },
  }
  const driver = new ClaudeDriver({
    credentials: pickClaudeCreds(),
    agentInfo: { version: '0.0.1-probe' },
    sdk: adapter,
  })
  try {
    const { sessionId } = await driver.newSession({
      cwd: WS,
      mcpServers: [],
      model: 'claude-haiku-4-5-20251001',
    })
    const { events, emit } = recorder()
    await driver.prompt(sessionId, { sessionId, prompt: [{ type: 'text', text: prompt }] }, emit)
    return { output: joinOutput(events).trim(), tools: toolCalls(events) }
  } catch (e) {
    return { output: '', tools: [], threw: e instanceof Error ? e.message : String(e) }
  }
}

async function runOpencode(prompt: string): Promise<{ output: string; events?: string; threw?: string }> {
  try {
    const auth = readFileSync(`${homedir()}/.local/share/opencode/auth.json`, 'utf8')
    const driver = new OpencodeDriver({ agentInfo: { version: '0.0.1-probe' } })
    const { sessionId } = await driver.newSession({
      cwd: WS,
      mcpServers: [],
      model: 'opencode-go/deepseek-v4-flash',
      toolPolicy: { defaultMode: 'bypassPermissions' },
      _meta: { opencodeAuth: auth },
    } as never)
    const { events, emit } = recorder()
    const result = await driver.prompt(sessionId, { sessionId, prompt: [{ type: 'text', text: prompt }] }, emit)
    const summary = events.map((e) => e.type).join('|')
    return { output: joinOutput(events).trim(), events: `${result.stopReason ?? '?'} :: ${summary}` }
  } catch (e) {
    return { output: '', threw: e instanceof Error ? e.message : String(e) }
  }
}

async function main(): Promise<void> {
  const log = (...a: unknown[]): void => {
    process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`)
  }

  const report: Record<
    string,
    { output: string; tools?: string; pizzaHit: boolean; zebraHit: boolean; threw?: string }
  > = {}

  async function probeClaude(label: string, variant: 'omit' | 'empty' | 'project' | 'all'): Promise<void> {
    log(`--- Claude ${label}: settingSources=${variant} ---`)
    const p = await runClaudeVariant(variant, PROMPT_PIZZA)
    const z = await runClaudeVariant(variant, PROMPT_ZEBRA)
    report[`claude_${variant}`] = {
      output: `pizza=${p.output} | zebra=${z.output}`,
      tools: [...new Set([...p.tools, ...z.tools])].join(','),
      pizzaHit: p.output.includes('4242'),
      zebraHit: z.output.includes('9988'),
      ...(p.threw !== undefined ? { threw: p.threw } : {}),
    }
    log('  ', report[`claude_${variant}`])
  }

  await probeClaude('A', 'omit')
  await probeClaude('B', 'empty')
  await probeClaude('C', 'project')
  await probeClaude('D', 'all')

  log('--- Opencode default driver (cwd=ws) ---')
  {
    const r = await runOpencode(PROMPT_PIZZA)
    report.opencode = {
      output: `${r.output} ::events:: ${r.events ?? '-'}`,
      pizzaHit: r.output.includes('4242'),
      zebraHit: r.output.includes('9988'),
      ...(r.threw !== undefined ? { threw: r.threw } : {}),
    }
    log('  ', report.opencode)
  }

  log('\n=== SUMMARY ===')
  for (const [k, v] of Object.entries(report)) {
    log(
      `${k.padEnd(20)} pizza=${v.pizzaHit ? 'HIT' : 'miss'} zebra=${v.zebraHit ? 'HIT' : 'miss'}${v.threw ? ` THREW=${v.threw.slice(0, 80)}` : ''}`,
    )
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

void main().then(() => process.exit(0))
