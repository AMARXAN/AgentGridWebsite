import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const TOKEN_TTL_SECONDS = 60 * 60 * 12

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${derived}`
}

export function verifyPassword(password, stored) {
  // Treat malformed persisted hashes as a failed login, not a server error.
  // Current hashes use a 16-byte hex salt and a 64-byte scrypt digest.
  if (typeof password !== 'string' || typeof stored !== 'string') return false
  const parts = stored.split(':')
  if (parts.length !== 2) return false
  const [salt, expectedHex] = parts
  if (!/^[a-f0-9]{32}$/i.test(salt) || !/^[a-f0-9]{128}$/i.test(expectedHex)) return false
  try {
    const actual = scryptSync(password, salt, 64)
    const expected = Buffer.from(expectedHex, 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

export function issueToken(user, secret, now = Math.floor(Date.now() / 1000)) {
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    workspaceId: user.workspaceId,
    email: user.email,
    role: user.role,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  })).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

export function verifyToken(token, secret, now = Math.floor(Date.now() / 1000)) {
  // Bound untrusted bearer tokens before decoding or computing an HMAC.
  if (typeof token !== 'string' || token.length > 4096) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, signature] = parts
  const expected = Buffer.from(sign(payload, secret))
  const supplied = Buffer.from(signature)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof decoded.sub !== 'string' || decoded.sub.length < 1 || decoded.sub.length > 128) return null
    if (typeof decoded.workspaceId !== 'string' || decoded.workspaceId.length < 1 || decoded.workspaceId.length > 128) return null
    if (!Number.isFinite(decoded.iat) || decoded.iat > now + 60) return null
    if (!Number.isFinite(decoded.exp) || decoded.exp <= now || decoded.exp - decoded.iat > TOKEN_TTL_SECONDS) return null
    return decoded
  } catch { return null }
}
