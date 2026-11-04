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

  test('ignores defaultMode and dedupes in order', () => {
    expect(
      rules({
        defaultMode: 'bypassPermissions',
        deny: ['Read:/proc/**', 'Bash:git push*', 'Read:/proc/**', 'Bash:git push*'],
      }),
    ).toEqual({
      allow: [],
      deny: ['Read(//proc/**)', 'Bash(git push*)'],
      ask: [],
    })
  })

  test('returns null for a top-level key outside allow, deny, ask and defaultMode', () => {
    expect(rules({ deny: ['Read:/proc/**'], extra: 1 })).toBeNull()
    expect(rules({ allowed: ['Read'] })).toBeNull()
    expect(parseToolPolicy('{"__proto__":{},"deny":[]}')).toBeNull()
  })

  test('dedupes entries that translate to the same rule', () => {
    expect(rules({ allow: ['Read:/a/**', 'Read://a/**'], deny: ['Read:/a/**', 'Glob:/a/**'] })).toEqual({
      allow: ['Read(//a/**)'],
      deny: ['Read(//a/**)'],
      ask: [],
    })
  })

  test('keeps server and tool level MCP entries working', () => {
    expect(rules({ allow: ['mcp:kodizm', 'mcp:kodizm/*', 'mcp:kodizm/ping_kodizm'] })?.allow).toEqual([
      'mcp__kodizm',
      'mcp__kodizm__*',
      'mcp__kodizm__ping_kodizm',
    ])
  })

  test('returns null for a bare mcp entry', () => {
    expect(rules({ deny: ['mcp'] })).toBeNull()
  })

  test('returns null for an MCP server segment that is or holds a wildcard', () => {
    expect(rules({ deny: ['mcp:*'] })).toBeNull()
    expect(rules({ deny: ['mcp:ko*'] })).toBeNull()
    expect(rules({ deny: ['mcp:*/ping'] })).toBeNull()
  })

  test('returns null for an MCP entry with more than two path segments', () => {
    expect(rules({ deny: ['mcp:kodizm/ping/extra'] })).toBeNull()
  })

  test('returns null for an MCP tool segment that holds a wildcard without being exactly one', () => {
    expect(rules({ deny: ['mcp:kodizm/ping*'] })).toBeNull()
    expect(rules({ deny: ['mcp:kodizm/*ping'] })).toBeNull()
    expect(rules({ deny: ['mcp:kodizm/**'] })).toBeNull()
  })

  test('returns null for an MCP name that carries parentheses', () => {
    expect(rules({ deny: ['mcp:ko(dizm'] })).toBeNull()
    expect(rules({ deny: ['mcp:kodizm/ping()'] })).toBeNull()
  })

  test('returns null for a tool name that is not capitalized alphanumerics', () => {
    for (const entry of [
      'read',
      'constructor',
      '__proto__',
      'toString',
      'read:/a',
      'constructor:x',
      'Re-ad',
      '1Read',
    ]) {
      expect(rules({ deny: [entry] })).toBeNull()
    }
  })

  test('returns null for a path argument on a tool that only collapses in the allow list', () => {
    for (const entry of ['Glob:/data/**', 'Grep:src/**', 'Write:/a/b', 'MultiEdit:/a/**', 'NotebookEdit:nb/**']) {
      expect(rules({ allow: [entry] })).toBeNull()
    }
  })

  test('keeps the collapse of those tools in the deny and ask lists', () => {
    expect(rules({ deny: ['Glob:/data/**'], ask: ['Grep:~/y/**', 'Write:/a/b', 'NotebookEdit:nb/**'] })).toEqual({
      allow: [],
      deny: ['Read(//data/**)'],
      ask: ['Read(~/y/**)', 'Edit(//a/b)', 'Edit(nb/**)'],
    })
  })

  test('keeps a Bash allow glob when the prefix ends in whitespace', () => {
    expect(rules({ allow: ['Bash:ls -la *', 'Bash:make\t*'] })?.allow).toEqual(['Bash(ls -la *)', 'Bash(make\t*)'])
  })

  test('escapes backslashes before parentheses in every rule argument', () => {
    expect(
      rules({
        allow: ['Bash:echo (hi)*'],
        deny: ['Bash:python -c "print(1)"', 'Bash:a\\(', 'Read:src/(x)/**', 'WebFetch:domain:a(b)'],
      }),
    ).toEqual({
      allow: ['Bash(echo \\(hi\\):*)'],
      deny: ['Bash(python -c "print\\(1\\)")', 'Bash(a\\\\\\()', 'Read(src/\\(x\\)/**)', 'WebFetch(domain:a\\(b\\))'],
      ask: [],
    })
  })

  test('returns null for a Bash colon star that is not a trailing prefix', () => {
    expect(rules({ deny: ['Bash:a:*b'] })).toBeNull()
    expect(rules({ allow: ['Bash::*'] })).toBeNull()
    expect(rules({ deny: ['Bash::*'] })).toBeNull()
  })

  test('keeps a Bash colon star prefix that ends the argument', () => {
    expect(rules({ deny: ['Bash:git:*'] })?.deny).toEqual(['Bash(git:*)'])
  })

  test('returns null for a file tool wildcard that is not at a path boundary', () => {
    expect(rules({ deny: ['Read:/etc/ssh/ssh_host_*_key'] })).toBeNull()
    expect(rules({ deny: ['Edit:src/a*b/c'] })).toBeNull()
  })

  test('keeps file tool wildcards at a path boundary', () => {
    expect(rules({ deny: ['Read:/etc/*.conf', 'Read:src/*/x', 'Edit:/etc/*', 'Edit:*.env'] })?.deny).toEqual([
      'Read(//etc/*.conf)',
      'Read(src/*/x)',
      'Edit(//etc/*)',
      'Edit(*.env)',
    ])
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
