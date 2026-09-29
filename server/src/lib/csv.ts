/**
 * RFC 4180 CSV parser.
 *
 * `line.split(',')` is the single most common cause of corrupted imports: it
 * breaks on `"Smith, Jane"`, on embedded newlines inside quoted notes, and on
 * escaped `""`. This is a small state machine that handles all of those, plus
 * CRLF and a UTF-8 BOM.
 */
export interface CsvParseResult {
  headers: string[]
  rows: string[][]
}

export function parseCsv(input: string): CsvParseResult {
  // Strip a UTF-8 BOM, which Excel loves to prepend and which otherwise
  // becomes part of the first header name.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    // Skip rows that are entirely empty (trailing newline at EOF).
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }

  while (i < text.length) {
    const ch = text[i]!

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"' // escaped quote
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }

    if (ch === '"' && field === '') {
      inQuotes = true
      i += 1
      continue
    }

    if (ch === ',') {
      endField()
      i += 1
      continue
    }

    if (ch === '\r') {
      // Consume CRLF as a single terminator.
      if (text[i + 1] === '\n') i += 1
      endRow()
      i += 1
      continue
    }

    if (ch === '\n') {
      endRow()
      i += 1
      continue
    }

    field += ch
    i += 1
  }

  // Flush whatever the last line left behind (file may not end with a newline).
  if (field !== '' || row.length > 0) endRow()

  if (rows.length === 0) return { headers: [], rows: [] }

  const headers = rows[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'))
  return { headers, rows: rows.slice(1) }
}

/** Builds a case/space-insensitive header → index map. */
export function indexHeaders(headers: string[]): Map<string, number> {
  const map = new Map<string, number>()
  headers.forEach((h, idx) => {
    map.set(h, idx)
    // Also index the bare form so "First Name" and "firstname" both resolve.
    const squashed = h.replace(/[^a-z0-9]/g, '')
    if (squashed && !map.has(squashed)) map.set(squashed, idx)
  })
  return map
}
