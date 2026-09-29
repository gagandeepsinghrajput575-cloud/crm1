import { describe, expect, it } from 'vitest'
import { indexHeaders, parseCsv } from '../src/lib/csv.js'

describe('parseCsv', () => {
  it('parses a simple table', () => {
    const { headers, rows } = parseCsv('name,phone\nMaya,+14155550141\nJonas,+491705550182')
    expect(headers).toEqual(['name', 'phone'])
    expect(rows).toEqual([
      ['Maya', '+14155550141'],
      ['Jonas', '+491705550182'],
    ])
  })

  it('handles a quoted field containing a comma', () => {
    // `line.split(',')` gets this wrong, which is the classic import bug.
    const { rows } = parseCsv('name,company\n"Smith, Jane",Northwind')
    expect(rows[0]).toEqual(['Smith, Jane', 'Northwind'])
  })

  it('handles escaped double quotes', () => {
    const { rows } = parseCsv('name,note\nMaya,"She said ""call me back"" loudly"')
    expect(rows[0]?.[1]).toBe('She said "call me back" loudly')
  })

  it('handles a newline inside a quoted field', () => {
    const { rows } = parseCsv('name,note\nMaya,"line one\nline two"')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.[1]).toBe('line one\nline two')
  })

  it('handles CRLF line endings', () => {
    const { rows } = parseCsv('a,b\r\n1,2\r\n3,4')
    expect(rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
  })

  it('strips a UTF-8 BOM from the first header', () => {
    const { headers } = parseCsv('﻿name,phone\nMaya,+14155550141')
    expect(headers[0]).toBe('name')
  })

  it('flushes a final row with no trailing newline', () => {
    const { rows } = parseCsv('a,b\n1,2')
    expect(rows).toEqual([['1', '2']])
  })

  it('ignores a trailing blank line', () => {
    const { rows } = parseCsv('a,b\n1,2\n')
    expect(rows).toEqual([['1', '2']])
  })

  it('preserves empty fields', () => {
    const { rows } = parseCsv('a,b,c\n1,,3')
    expect(rows[0]).toEqual(['1', '', '3'])
  })

  it('returns empty results for empty input', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] })
  })

  it('normalises header case and spacing', () => {
    const { headers } = parseCsv('First Name,PHONE NUMBER,Company Name')
    expect(headers).toEqual(['first_name', 'phone_number', 'company_name'])
  })
})

describe('indexHeaders', () => {
  it('indexes headers by their normalised form', () => {
    const index = indexHeaders(['first_name', 'phone'])
    expect(index.get('first_name')).toBe(0)
    expect(index.get('phone')).toBe(1)
  })

  it('also indexes a squashed form so "First Name" matches "firstname"', () => {
    const index = indexHeaders(['first_name'])
    expect(index.get('firstname')).toBe(0)
  })
})
