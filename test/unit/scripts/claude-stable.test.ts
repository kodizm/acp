import { describe, expect, test } from 'bun:test'

import {
  type SdkRelease,
  addChangelogEntry,
  bumpPackage,
  decide,
  isBotRelease,
  nextPatch,
  parseReleases,
} from '../../../scripts/claude-stable.ts'

const releases: SdkRelease[] = [
  { version: '0.3.280', claudeCodeVersion: '2.1.280' },
  { version: '0.3.311', claudeCodeVersion: '2.1.311' },
  { version: '0.3.312', claudeCodeVersion: '2.1.312' },
]

describe('decide', () => {
  test('bumps to the SDK that bundles the stable CLI', () => {
    const resolution = decide({ bucket: '2.1.311', npmTag: '2.1.311', releases, pinned: '0.3.280' })

    expect(resolution).toEqual({ kind: 'bump', cli: '2.1.311', sdk: '0.3.311', previousSdk: '0.3.280' })
  })

  test('reports unchanged when the pin already is the stable SDK', () => {
    const resolution = decide({ bucket: '2.1.311', npmTag: '2.1.311', releases, pinned: '0.3.311' })

    expect(resolution).toEqual({ kind: 'unchanged', cli: '2.1.311', sdk: '0.3.311' })
  })

  test('trims the newline the bucket file ends with', () => {
    const resolution = decide({ bucket: '2.1.311\n', npmTag: '2.1.311', releases, pinned: '0.3.280' })

    expect(resolution.kind).toBe('bump')
  })

  test('refuses to guess when the two stable pointers disagree', () => {
    expect(() => decide({ bucket: '2.1.311', npmTag: '2.1.319', releases, pinned: '0.3.280' })).toThrow(
      /2\.1\.311.*2\.1\.319/,
    )
  })

  test('refuses a pointer that is not a version', () => {
    expect(() => decide({ bucket: '<html>', npmTag: '<html>', releases, pinned: '0.3.280' })).toThrow(/version/)
  })

  test('waits when no SDK bundles the stable CLI yet', () => {
    const resolution = decide({ bucket: '2.1.313', npmTag: '2.1.313', releases, pinned: '0.3.280' })

    expect(resolution).toMatchObject({ kind: 'wait', cli: '2.1.313' })
  })

  test('picks the highest SDK when several bundle one CLI', () => {
    const rebuilt: SdkRelease[] = [...releases, { version: '0.4.0', claudeCodeVersion: '2.1.311' }]

    const resolution = decide({ bucket: '2.1.311', npmTag: '2.1.311', releases: rebuilt, pinned: '0.3.280' })

    expect(resolution).toMatchObject({ kind: 'bump', sdk: '0.4.0' })
  })

  test('ignores a pre-release SDK even when it bundles the stable CLI', () => {
    const preview: SdkRelease[] = [{ version: '0.3.311-beta.1', claudeCodeVersion: '2.1.311' }]

    const resolution = decide({ bucket: '2.1.311', npmTag: '2.1.311', releases: preview, pinned: '0.3.280' })

    expect(resolution).toMatchObject({ kind: 'wait', cli: '2.1.311' })
  })

  test('never moves the pin backwards when stable falls behind it', () => {
    const resolution = decide({ bucket: '2.1.280', npmTag: '2.1.280', releases, pinned: '0.3.311' })

    expect(resolution).toMatchObject({ kind: 'wait', cli: '2.1.280' })
  })
})

describe('parseReleases', () => {
  test('reads the array npm prints for a range', () => {
    expect(parseReleases('[{"version":"0.3.311","claudeCodeVersion":"2.1.311"}]')).toEqual([
      { version: '0.3.311', claudeCodeVersion: '2.1.311' },
    ])
  })

  test('reads the bare object npm prints for a single match', () => {
    expect(parseReleases('{"version":"0.3.311","claudeCodeVersion":"2.1.311"}')).toEqual([
      { version: '0.3.311', claudeCodeVersion: '2.1.311' },
    ])
  })

  test('treats empty output as no releases', () => {
    expect(parseReleases('')).toEqual([])
  })

  test('drops entries without a bundled CLI version', () => {
    expect(parseReleases('[{"version":"0.3.1"},{"version":"0.3.2","claudeCodeVersion":"2.1.2"}]')).toEqual([
      { version: '0.3.2', claudeCodeVersion: '2.1.2' },
    ])
  })
})

describe('nextPatch', () => {
  test('raises the patch number only', () => {
    expect(nextPatch('0.9.1')).toBe('0.9.2')
    expect(nextPatch('1.2.9')).toBe('1.2.10')
  })

  test('refuses a version it cannot read', () => {
    expect(() => nextPatch('0.9')).toThrow(/version/)
  })
})

describe('bumpPackage', () => {
  const source = `${JSON.stringify(
    {
      name: '@kodizm/acp',
      version: '0.9.1',
      config: { claudeAgentSdk: '0.3.280' },
      devDependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.280', zod: '^4.0.0' },
    },
    null,
    2,
  )}\n`

  test('moves the version and both SDK pins together', () => {
    const bumped = JSON.parse(bumpPackage(source, '0.3.311', '0.9.2'))

    expect(bumped.version).toBe('0.9.2')
    expect(bumped.config.claudeAgentSdk).toBe('0.3.311')
    expect(bumped.devDependencies['@anthropic-ai/claude-agent-sdk']).toBe('0.3.311')
    expect(bumped.devDependencies.zod).toBe('^4.0.0')
  })

  test('keeps the file formatting npm writes', () => {
    expect(bumpPackage(source, '0.3.280', '0.9.1')).toBe(source)
  })

  test('refuses a package that lost one of the pins', () => {
    const lost = source.replace('"claudeAgentSdk": "0.3.280"', '"other": "x"')

    expect(() => bumpPackage(lost, '0.3.311', '0.9.2')).toThrow(/claudeAgentSdk/)
  })
})

describe('addChangelogEntry', () => {
  const changelog = [
    '# Changelog',
    '',
    'All notable changes are documented here.',
    '',
    '## [0.9.1] - 2026-11-06',
    '',
    '### Added',
    '',
    '- Something.',
    '',
  ].join('\n')

  const entry = { version: '0.9.2', date: '2026-11-09', sdk: '0.3.311', cli: '2.1.311', previousSdk: '0.3.280' }

  test('puts the new release above the newest one', () => {
    const updated = addChangelogEntry(changelog, entry)

    expect(updated.indexOf('## [0.9.2] - 2026-11-09')).toBeLessThan(updated.indexOf('## [0.9.1]'))
    expect(updated.startsWith('# Changelog\n\nAll notable changes are documented here.\n\n## [0.9.2]')).toBe(true)
  })

  test('names both pins and the CLI the stable channel serves', () => {
    const updated = addChangelogEntry(changelog, entry)

    expect(updated).toContain('0.3.280')
    expect(updated).toContain('0.3.311')
    expect(updated).toContain('2.1.311')
  })

  test('keeps the older entries untouched', () => {
    expect(addChangelogEntry(changelog, entry)).toContain('## [0.9.1] - 2026-11-06\n\n### Added\n\n- Something.\n')
  })

  test('refuses a changelog that has no release heading to anchor on', () => {
    expect(() => addChangelogEntry('# Changelog\n', entry)).toThrow(/heading/)
  })
})

describe('isBotRelease', () => {
  const handWritten = ['# Changelog', '', '## [0.9.1] - 2026-11-06', '', '### Added', '', '- Something.', ''].join('\n')
  const entry = { version: '0.9.2', date: '2026-11-09', sdk: '0.3.311', cli: '2.1.311', previousSdk: '0.3.280' }

  test('recognises a release the bump workflow wrote', () => {
    expect(isBotRelease(addChangelogEntry(handWritten, entry), '0.9.2')).toBe(true)
  })

  test('does not claim a hand-written release', () => {
    expect(isBotRelease(handWritten, '0.9.1')).toBe(false)
  })

  test('does not read the marker across release sections', () => {
    expect(isBotRelease(addChangelogEntry(handWritten, entry), '0.9.1')).toBe(false)
  })

  test('is false for a version the changelog does not list', () => {
    expect(isBotRelease(addChangelogEntry(handWritten, entry), '0.9.3')).toBe(false)
  })
})
