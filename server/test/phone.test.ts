import { describe, expect, it } from 'vitest'
import { isValidE164, normalizePhone, requirePhone } from '../src/lib/phone.js'
import { AppError } from '../src/lib/errors.js'

describe('normalizePhone', () => {
  it('keeps an already-normalised E.164 number intact', () => {
    const result = normalizePhone('+14155550141')
    expect(result).toMatchObject({ ok: true, e164: '+14155550141' })
  })

  it('strips formatting characters', () => {
    const result = normalizePhone('+1 (415) 555-0141')
    expect(result).toMatchObject({ ok: true, e164: '+14155550141' })
  })

  it('accepts the 00 international prefix', () => {
    const result = normalizePhone('0044 20 7946 0018')
    expect(result).toMatchObject({ ok: true, e164: '+442079460018' })
  })

  it('accepts the 011 international prefix', () => {
    const result = normalizePhone('011 44 20 7946 0018')
    expect(result).toMatchObject({ ok: true, e164: '+442079460018' })
  })

  it('handles non-NANP international numbers without mangling them', () => {
    // The original frontend helper prefixed every 10-digit number with "1",
    // which would have turned this German number into an invalid one.
    for (const [input, expected] of [
      ['+49 170 555 0182', '+491705550182'],
      ['+91 98200 44510', '+919820044510'],
      ['+81 90 1234 5678', '+819012345678'],
      ['+353 85 123 4567', '+353851234567'],
    ] as const) {
      expect(normalizePhone(input)).toMatchObject({ ok: true, e164: expected })
    }
  })

  it('prefixes the default country code for national format', () => {
    expect(normalizePhone('4155550141')).toMatchObject({ ok: true, e164: '+14155550141' })
  })

  it('honours a caller-supplied default country code', () => {
    // A German agent pasting a local number must not get a +1 prefix.
    expect(normalizePhone('1705550182', '49')).toMatchObject({ ok: true, e164: '+491705550182' })
  })

  it('rejects empty input', () => {
    expect(normalizePhone('')).toMatchObject({ ok: false })
    expect(normalizePhone(null)).toMatchObject({ ok: false })
    expect(normalizePhone(undefined)).toMatchObject({ ok: false })
  })

  it('rejects numbers with no digits', () => {
    expect(normalizePhone('not a phone')).toMatchObject({ ok: false })
  })

  it('rejects numbers that are too short', () => {
    expect(normalizePhone('+12345')).toMatchObject({ ok: false })
  })

  it('rejects numbers longer than E.164 allows', () => {
    expect(normalizePhone('+1234567890123456789')).toMatchObject({ ok: false })
  })

  it('rejects an international number starting with a zero', () => {
    // E.164 forbids a leading zero in the country code.
    expect(normalizePhone('+0415555014')).toMatchObject({ ok: false })
  })
})

describe('requirePhone', () => {
  it('returns the E.164 form when valid', () => {
    expect(requirePhone('(415) 555-0141')).toBe('+14155550141')
  })

  it('throws an AppError carrying a 400 when invalid', () => {
    try {
      requirePhone('abc')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).statusCode).toBe(400)
      expect((err as AppError).code).toBe('BAD_REQUEST')
    }
  })
})

describe('isValidE164', () => {
  it('accepts well-formed numbers', () => {
    expect(isValidE164('+14155550141')).toBe(true)
    expect(isValidE164('+819012345678')).toBe(true)
  })

  it('rejects malformed numbers', () => {
    expect(isValidE164('14155550141')).toBe(false) // no plus
    expect(isValidE164('+0415555014')).toBe(false) // leading zero
    expect(isValidE164('+123')).toBe(false) // too short
    expect(isValidE164('+1234567890123456')).toBe(false) // too long
  })
})
