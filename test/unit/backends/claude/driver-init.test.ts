import { describe, expect, test } from 'bun:test'

import { ClaudeDriver, type SdkAdapter } from '@/backends/claude/driver.ts'

function makeStubAdapter(): SdkAdapter {
  return {
    async *query() {
      // No messages; init/newSession tests do not invoke prompt.
    },
  }
}

function makeDriver() {
  return new ClaudeDriver({
    credentials: { type: 'api-key', token: 'sk-ant-fake' },
    agentInfo: { version: '0.0.1-test' },
    sdk: makeStubAdapter(),
  })
}

describe('ClaudeDriver.initialize', () => {
  test('returns protocolVersion + agentInfo + full capabilities', async () => {
    const driver = makeDriver()
    const result = await driver.initialize({ protocolVersion: 1 })

    expect(result.protocolVersion).toBe(1)
    expect(result.agentInfo).toEqual({ version: '0.0.1-test' })
    expect(result.capabilities).toEqual({
      resume: true,
      fork: true,
      fileUpload: true,
      thinking: true,
      subagent: true,
      skillEvents: true,
      debug: true,
    })
  })
})

describe('ClaudeDriver.newSession + buildSdkOptions', () => {
  test('allocates a session id and stores the SDK options', async () => {
    const driver = makeDriver()
    const result = await driver.newSession({ cwd: '/workspace', mcpServers: [] })

    expect(typeof result.sessionId).toBe('string')
    expect(result.sessionId.length).toBeGreaterThan(0)
  })

  test('cwd flows through to the SDK options', () => {
    const driver = makeDriver()
    const options = driver.buildSdkOptions({ cwd: '/workspace/auto-mount-test', mcpServers: [] })
    expect(options.cwd).toBe('/workspace/auto-mount-test')
  })

  test('mcpServers translates to the SDK keyed-record shape', () => {
    const driver = makeDriver()
    const options = driver.buildSdkOptions({
      cwd: '/workspace',
      mcpServers: [
        {
          type: 'http',
          name: 'kodizm',
          url: 'https://kodizm.com/mcp/internal',
          headers: [{ name: 'Authorization', value: 'Bearer kdz-int-jwt.x.y' }],
        },
      ],
    })

    expect(options.mcpServers).toEqual({
      kodizm: {
        type: 'http',
        url: 'https://kodizm.com/mcp/internal',
        headers: { Authorization: 'Bearer kdz-int-jwt.x.y' },
      },
    })
  })

  test('additionalDirectories flows through', () => {
    const driver = makeDriver()
    const options = driver.buildSdkOptions({
      cwd: '/workspace',
      mcpServers: [],
      additionalDirectories: ['/data/shared', '/mnt/repo'],
    })

    expect(options.additionalDirectories).toEqual(['/data/shared', '/mnt/repo'])
  })

  test('skills array flows through to SDK options', () => {
    const driver = makeDriver()
    const options = driver.buildSdkOptions({
      cwd: '/workspace',
      mcpServers: [],
      skills: ['my-coding', 'my-language'],
    })

    expect(options.skills).toEqual(['my-coding', 'my-language'])
  })

  test('empty skills array is dropped (SDK default behavior preserved)', () => {
    const driver = makeDriver()
    const options = driver.buildSdkOptions({
      cwd: '/workspace',
      mcpServers: [],
      skills: [],
    })

    expect(options.skills).toBeUndefined()
  })

  test('systemPrompt as a string => full replacement', () => {
    const driver = makeDriver()
    const options = driver.buildSdkOptions({
      cwd: '/workspace',
      mcpServers: [],
      systemPrompt: 'You are a senior reviewer.',
    })

    expect(options.systemPrompt).toBe('You are a senior reviewer.')
  })

  test('systemPrompt as { append } => preset + append shape', () => {
    const driver = makeDriver()
    const options = driver.buildSdkOptions({
      cwd: '/workspace',
      mcpServers: [],
      systemPrompt: { append: 'Always respond in Turkish.' },
    })

    expect(options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Always respond in Turkish.',
    })
  })

  test('systemPrompt undefined => default preset', () => {
    const driver = makeDriver()
    const options = driver.buildSdkOptions({ cwd: '/workspace', mcpServers: [] })

    expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' })
  })

  test('model flows through when provided', () => {
    const driver = makeDriver()
    const options = driver.buildSdkOptions({
      cwd: '/workspace',
      mcpServers: [],
      model: 'claude-sonnet-4-6',
    })

    expect(options.model).toBe('claude-sonnet-4-6')
  })

  test('omits model when not provided', () => {
    const driver = makeDriver()
    const options = driver.buildSdkOptions({ cwd: '/workspace', mcpServers: [] })

    expect(options.model).toBeUndefined()
  })
})
