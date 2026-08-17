import test from 'node:test'
import assert from 'node:assert'
import { filterOwnedAnthropicEnv, OWNED_ANTHROPIC_ENV } from './env-filter.mjs'

test('filter removes owned ANTHROPIC_* keys but keeps everything else', () => {
  const input = {
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'keep',
    DISABLE_AUTOUPDATER: '1',
    ANTHROPIC_BASE_URL: 'drop',
    ANTHROPIC_MODEL: 'drop',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'drop',
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'drop',
    CLAUDE_CLI_PATH: 'drop',
  }
  const out = filterOwnedAnthropicEnv(input)
  assert.strictEqual(out.PATH, '/usr/bin')
  assert.strictEqual(out.OPENAI_API_KEY, 'keep')
  assert.strictEqual(out.DISABLE_AUTOUPDATER, '1')
  for (const key of Object.keys(input)) {
    if (!['PATH', 'OPENAI_API_KEY', 'DISABLE_AUTOUPDATER'].includes(key)) {
      assert.strictEqual(out[key], undefined, `expected ${key} to be filtered`)
    }
  }
})

test('OWNED_ANTHROPIC_ENV has 11 keys including _NAME mirrors', () => {
  assert.strictEqual(OWNED_ANTHROPIC_ENV.length, 11)
  assert.ok(OWNED_ANTHROPIC_ENV.includes('ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME'))
  assert.ok(OWNED_ANTHROPIC_ENV.includes('ANTHROPIC_BASE_URL'))
  assert.ok(OWNED_ANTHROPIC_ENV.includes('CLAUDE_CLI_PATH'))
})
