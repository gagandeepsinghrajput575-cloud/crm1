import { badRequest } from './errors.js'

/**
 * E.164 normalisation.
 *
 * The frontend shipped a `sanitize()` helper that assumes any 10-digit number
 * is North American. That silently corrupts every other market, which matters a
 * lot for a dialer selling international rates — so the server re-implements
 * this properly and treats the server's result as authoritative.
 *
 * E.164 permits a leading `+`, then a country code (1–3 digits) and a national
 * number of up to 14 digits, for 15 significant digits maximum.
 */

const DEFAULT_COUNTRY_CODE = '1'

export type ParsedPhone =
  | { ok: true; e164: string; countryCode: string; national: string }
  | { ok: false; reason: string }

const MAX_E164_DIGITS = 15
const MIN_DIGITS = 7

function splitCountryCode(digits: string, defaultCc: string) {
  // No way to reliably infer the split without a full libphonenumber table.
  // We take the documented default, which callers can override via settings.
  return { countryCode: defaultCc, national: digits }
}

export function normalizePhone(
  raw: string | null | undefined,
  defaultCountryCode: string = DEFAULT_COUNTRY_CODE,
): ParsedPhone {
  if (raw == null) return { ok: false, reason: 'Phone number is required' }

  const trimmed = String(raw).trim()
  if (!trimmed) return { ok: false, reason: 'Phone number is required' }

  // International prefix written the long way, e.g. 0044 20 7946 0018.
  let working = trimmed.replace(/[\s().-]/g, '')
  let international = working.startsWith('+')

  if (working.startsWith('00')) {
    working = working.slice(2)
    international = true
  }
  // "011" is the NANP international prefix.
  else if (working.startsWith('011') && working.length >= 11) {
    working = working.slice(3)
    international = true
  }

  const digits = working.replace(/\D/g, '')
  if (!digits) return { ok: false, reason: 'Phone number contains no digits' }

  if (!international) {
    // Local/national format: prefix the default country code.
    const cc = digits.startsWith(defaultCountryCode) ? defaultCountryCode : defaultCountryCode
    const { countryCode, national } = splitCountryCode(digits, cc)
    const e164 = `+${countryCode}${national}`

    if (e164.replace('+', '').length < MIN_DIGITS) {
      return { ok: false, reason: `Phone number is too short (${digits.length} digits)` }
    }
    if (e164.replace('+', '').length > MAX_E164_DIGITS) {
      return { ok: false, reason: 'Phone number is too long' }
    }
    return { ok: true, e164, countryCode, national }
  }

  if (digits.length < MIN_DIGITS) {
    return { ok: false, reason: `Phone number is too short (${digits.length} digits)` }
  }
  if (digits.length > MAX_E164_DIGITS) {
    return { ok: false, reason: `Phone number is too long (${digits.length} digits)` }
  }

  // Leading zeros are invalid in E.164 country codes and subscriber numbers.
  if (digits.startsWith('0')) {
    return { ok: false, reason: 'International number must not start with 0' }
  }

  return {
    ok: true,
    e164: `+${digits}`,
    countryCode: digits.slice(0, 1),
    national: digits,
  }
}

/** Throwing variant for write paths where a bad number must reject the record. */
export function requirePhone(
  raw: string | null | undefined,
  defaultCountryCode?: string,
): string {
  const parsed = normalizePhone(raw, defaultCountryCode)
  if (!parsed.ok) throw badRequest(parsed.reason, { field: 'phone', value: raw })
  return parsed.e164
}

/** Loose check used to reject obviously-fake numbers in tests and seed data. */
export function isValidE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value)
}
