import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * API-key handling.
 *
 * The key is a high-entropy random string, so a plain SHA-256 is the correct
 * primitive here (unlike a user-chosen password, which would need a slow KDF).
 * We never store the key itself — only its hash — and we compare with a
 * constant-time function so response timing cannot leak a prefix match.
 */

export function generateApiKey(): string {
  return `df_${randomBytes(32).toString('base64url')}`
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** Non-secret, human-recognisable fragment shown in logs and the settings UI. */
export function keyPrefix(key: string): string {
  return key.slice(0, 11)
}

/**
 * Constant-time string comparison. Buffers are compared only when the lengths
 * match, because `timingSafeEqual` throws on length mismatch — the length of a
 * 32-byte digest is not a meaningful secret.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
