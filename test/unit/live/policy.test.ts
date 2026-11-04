import { describe, expect, test } from 'bun:test'

import { parseToolPolicy } from '@/live/policy.ts'

function rules(policy: unknown): ReturnType<typeof parseToolPolicy> {
  return parseToolPolicy(JSON.stringify(policy))
}

describe('parseToolPolicy', () => {
  test('passes a bare tool name and turns a lone wildcard arg into the bare name', () => {
    expect(rules({ allow: ['Read', 'Edit:*', 'WebFetch:*', 'Glob', 'Write'] })).toEqual({
      allow: ['Read', 'Edit', 'WebFetch', 'Glob', 'Write'],
      deny: [],
      ask: [],
    })
  })

  test('anchors an absolute file path with one more slash', () => {
    expect(rules({ deny: ['Read:/proc/**', 'Edit:/etc/**'] })?.deny).toEqual(['Read(//proc/**)', 'Edit(//etc/**)'])
  })

  test('leaves an already anchored, home, dot relative and bare relative path unchanged', () => {
    expect(rules({ allow: ['Read://proc/**', 'Read:~/.claude/**', 'Read:./src/**', 'Read:src/**'] })?.allow).toEqual([
      'Read(//proc/**)',
      'Read(~/.claude/**)',
      'Read(./src/**)',
      'Read(src/**)',
    ])
  })

  test('renames Write, MultiEdit and NotebookEdit to Edit and Glob and Grep to Read when an arg is present', () => {
    expect(
      rules({
        deny: ['Write:/workspace/.env', 'MultiEdit:/a/**', 'NotebookEdit:nb/**', 'Glob:/x/**', 'Grep:~/y/**'],
      })?.deny,
    ).toEqual(['Edit(//workspace/.env)', 'Edit(//a/**)', 'Edit(nb/**)', 'Read(//x/**)', 'Read(~/y/**)'])
  })

  test('rejects the whole policy when a file tool arg holds the Bash prefix form', () => {
    expect(rules({ allow: ['Read', 'Read:/a:*'] })).toBeNull()
    expect(rules({ deny: ['Glob:src:*/**'] })).toBeNull()
  })

  test('uses the prefix form for a trailing wildcard only in the allow list', () => {
    const policy = rules({
      allow: ['Bash:git status*', 'Bash:npm test'],
      deny: ['Bash:git push*'],
      ask: ['Bash:rm *'],
    })

    expect(policy).toEqual({
      allow: ['Bash(git status:*)', 'Bash(npm test)'],
      deny: ['Bash(git push*)'],
      ask: ['Bash(rm *)'],
    })
  })

  test('passes a Bash glob with another wildcard unchanged in every list', () => {
    expect(
      rules({
        allow: ['Bash:git * push*'],
        deny: ['Bash:git * push*'],
        ask: ['Bash:git * push*'],
      }),
    ).toEqual({
      allow: ['Bash(git * push*)'],
      deny: ['Bash(git * push*)'],
      ask: ['Bash(git * push*)'],
    })
  })

  test('turns Bash with a lone wildcard into the bare tool', () => {
    expect(rules({ allow: ['Bash:*'], deny: ['Bash:*'] })).toEqual({
      allow: ['Bash'],
      deny: ['Bash'],
      ask: [],
    })
  })

  test('maps MCP servers and tools to the double underscore form', () => {
    expect(rules({ allow: ['mcp:kodizm', 'mcp:kodizm/post_comment', 'mcp:kodizm/*'] })?.allow).toEqual([
      'mcp__kodizm',
      'mcp__kodizm__post_comment',
      'mcp__kodizm__*',
    ])
  })

  test('ignores defaultMode and unknown keys and dedupes in order', () => {
    expect(
      rules({
        defaultMode: 'bypassPermissions',
        extra: 1,
        deny: ['Read:/proc/**', 'Bash:git push*', 'Read:/proc/**', 'Bash:git push*'],
      }),
    ).toEqual({
      allow: [],
      deny: ['Read(//proc/**)', 'Bash(git push*)'],
      ask: [],
    })
  })

  test('dedupes entries that translate to the same rule', () => {
    expect(rules({ allow: ['Read:/a/**', 'Read://a/**', 'Glob:/a/**'] })?.allow).toEqual(['Read(//a/**)'])
  })

  test('returns null for text that is not a policy', () => {
    for (const text of ['not json', '[]', 'null', '"Read"', '{"allow":"Read"}', '{"deny":[1]}', '{"ask":null}']) {
      expect(parseToolPolicy(text)).toBeNull()
    }
  })

  test('returns null when one pattern does not parse', () => {
    expect(rules({ allow: ['Read', 'Read:'] })).toBeNull()
    expect(rules({ deny: [''] })).toBeNull()
    expect(rules({ ask: ['mcp:kodizm/'] })).toBeNull()
    expect(rules({ allow: [':x'] })).toBeNull()
  })
})
