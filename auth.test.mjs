import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { hashPassword, verifyPassword, issueToken, verifyToken } from './auth.mjs'

test('password hashes verify only the original password', () => {
  const hash = hashPassword('a-strong-password-123')
  assert.equal(verifyPassword('a-strong-password-123', hash), true)
  assert.equal(verifyPassword('wrong-password', hash), false)
})

test('malformed persisted password hashes fail closed without throwing', () => {
  for (const stored of [null, '', 'no-separator', ':abc', 'bad-salt:'.concat('a'.repeat(128)), 'a'.repeat(32) + ':xyz', 'a'.repeat(32) + ':' + 'g'.repeat(128), 'a'.repeat(32) + ':' + 'a'.repeat(128) + ':extra']) {
    assert.doesNotThrow(() => verifyPassword('any-password', stored))
    assert.equal(verifyPassword('any-password', stored), false)
  }
  assert.equal(verifyPassword(null, 'a'.repeat(32) + ':' + 'a'.repeat(128)), false)
})

test('signed access token validates and expires', () => {
  const secret = 'a-long-random-test-secret-value'
  const token = issueToken({ id: 'u1', workspaceId: 'w1', email: 'a@example.com', role: 'owner' }, secret, 1000)
  assert.equal(verifyToken(token, secret, 1001)?.sub, 'u1')
  assert.equal(verifyToken(token, 'different-secret', 1001), null)
  assert.equal(verifyToken(token, secret, 1000 + 60 * 60 * 12), null)
  assert.equal(verifyToken('bad.token.value', secret, 1001), null)
})

test('token signature tampering is rejected', () => {
  const secret = 'a-long-random-test-secret-value'
  const token = issueToken({ id: 'u1', workspaceId: 'w1', email: 'a@example.com', role: 'owner' }, secret, 1000)
  const [payload, signature] = token.split('.')
  assert.equal(verifyToken(`${payload.slice(0, -1)}x.${signature}`, secret, 1001), null)
})


test('token verification rejects oversized and structurally invalid payloads', () => {
  const secret = 'a-long-random-test-secret-value'
  assert.equal(verifyToken('a'.repeat(4097), secret, 1001), null)

  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const sign = payload => createHmac('sha256', secret).update(payload).digest('base64url')
  const invalidTokens = [
    { sub: 12, workspaceId: 'w1', iat: 1000, exp: 2000 },
    { sub: 'u1', workspaceId: '', iat: 1000, exp: 2000 },
    { sub: 'u1', workspaceId: 'w1', iat: 1100, exp: 2000 },
    { sub: 'u1', workspaceId: 'w1', iat: 1000, exp: 1000 + 60 * 60 * 13 },
  ]
  for (const value of invalidTokens) {
    const payload = encode(value)
    assert.equal(verifyToken(`${payload}.${sign(payload)}`, secret, 1001), null)
  }
})
