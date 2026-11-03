import { describe, expect, test } from 'bun:test'

import pkg from '../../package.json'

/**
 * The image installs `@kodizm/acp` with `npm i -g --omit=optional` and
 * fetches the CLI platform package whose version equals
 * `config.claudeAgentSdk`, so the pin must be exact and the published
 * package must carry no runtime dependency (`bun build` inlines them).
 */
describe('package pin', () => {
  const sdkPin = pkg.devDependencies['@anthropic-ai/claude-agent-sdk']

  test('the SDK is pinned to an exact version', () => {
    expect(sdkPin).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('config.claudeAgentSdk equals the SDK pin', () => {
    expect(pkg.config.claudeAgentSdk).toBe(sdkPin)
  })

  test('the package ships with zero runtime dependencies', () => {
    expect('dependencies' in pkg).toBe(false)
  })
})
