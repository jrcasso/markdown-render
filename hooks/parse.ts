export type AlertKind = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION'

export type Segment =
  | { kind: 'markdown'; text: string }
  | { kind: 'mermaid'; source: string; isClosed: boolean }
  | { kind: 'alert'; alert: AlertKind; body: string }
  | { kind: 'details'; summary: string; body: string }
  | { kind: 'rule' }

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const ALERT_HEAD = /^ {0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i
const QUOTE_LINE = /^ {0,3}>/
const THEMATIC = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/
const HR_TAG = /^\s*<hr\s*\/?>\s*$/i
const DETAILS_OPEN = /<details[\s>]/i
const DETAILS_CLOSE = /<\/details\s*>/i
const SUMMARY = /<summary[^>]*>([\s\S]*?)<\/summary>/i

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
}

const superscript = (id: string): string =>
  /^\d+$/.test(id) ? [...id].map(d => SUPERSCRIPT[d]).join('') : `[${id}]`

export const rewriteProse = (text: string): string =>
  text
    .replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[ \]\s/gm, '$1☐ ')
    .replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[[xX]\]\s/gm, '$1☑ ')
    .replace(/^\[\^([^\]\s]+)\]:\s*/gm, (_, id: string) => `${superscript(id)} `)
    .replace(/\[\^([^\]\s]+)\]/g, (_, id: string) => superscript(id))
    .replace(/<\/?details[^>]*>/gi, '')
    .replace(/<summary>([\s\S]*?)<\/summary>/gi, (_, s: string) => `**▾ ${s.trim()}**`)
    .replace(/<kbd>([^<]*)<\/kbd>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '  \n')

export const rewriteOutsideFences = (text: string): string => {
  const out: string[] = []
  let prose: string[] = []
  let fence: string | null = null

  const flush = () => {
    if (prose.length > 0) out.push(rewriteProse(prose.join('\n')))
    prose = []
  }

  for (const line of text.split('\n')) {
    if (fence === null) {
      const m = FENCE_OPEN.exec(line)
      if (m) {
        flush()
        fence = m[1] ?? '```'
        out.push(line)
      } else {
        prose.push(line)
      }
    } else {
      out.push(line)
      if (isFenceClose(line, fence)) fence = null
    }
  }
  flush()
  return out.join('\n')
}

const isFenceClose = (line: string, fence: string): boolean => {
  const t = line.trim()
  return t.length >= fence.length && t[0] === fence[0] && [...t].every(c => c === fence[0])
}

export const parse = (text: string): Segment[] => {
  const lines = text.split('\n')
  const at = (k: number): string => lines[k] ?? ''
  const segments: Segment[] = []
  let buffer: string[] = []

  const flush = () => {
    if (buffer.length === 0) return
    const md = rewriteOutsideFences(buffer.join('\n')).replace(/^\s*\n|\n\s*$/g, '')
    if (md.trim() !== '') segments.push({ kind: 'markdown', text: md })
    buffer = []
  }

  let i = 0
  while (i < lines.length) {
    const line = at(i)
    const fence = FENCE_OPEN.exec(line)

    if (fence) {
      const marker = fence[1] ?? '```'
      const lang = fence[2] ?? ''
      let j = i + 1
      while (j < lines.length && !isFenceClose(at(j), marker)) j++
      const isClosed = j < lines.length
      if (lang.toLowerCase() === 'mermaid') {
        flush()
        segments.push({ kind: 'mermaid', source: lines.slice(i + 1, j).join('\n'), isClosed })
      } else {
        buffer.push(...lines.slice(i, Math.min(j + 1, lines.length)))
      }
      i = j + 1
      continue
    }

    const thematic = THEMATIC.exec(line)
    // A dash run directly under a paragraph line is a setext heading, not a
    // break, so it stays in the buffer for the markdown renderer.
    const isSetext = thematic?.[1] === '-' && i > 0 && at(i - 1).trim() !== ''
    if (HR_TAG.test(line) || (thematic !== null && !isSetext)) {
      flush()
      segments.push({ kind: 'rule' })
      i++
      continue
    }

    if (DETAILS_OPEN.test(line)) {
      let j = i
      while (j < lines.length && !DETAILS_CLOSE.test(at(j))) j++
      if (j < lines.length) {
        flush()
        const raw = lines.slice(i, j + 1).join('\n')
        // The summary is drawn in a plain Text, which renders no markup, so
        // inline tags would otherwise show raw. It is a one-line label too.
        const summary = SUMMARY.exec(raw)?.[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
        const body = raw
          .replace(SUMMARY, '')
          .replace(/<\/?details[^>]*>/gi, '')
          .trim()
        segments.push({
          kind: 'details',
          summary: summary !== undefined && summary !== '' ? summary : 'Details',
          body: rewriteOutsideFences(body),
        })
        i = j + 1
        continue
      }
    }

    const alert = ALERT_HEAD.exec(line)
    if (alert) {
      flush()
      let j = i + 1
      const body: string[] = []
      while (j < lines.length && QUOTE_LINE.test(at(j))) {
        body.push(at(j).replace(/^ {0,3}> ?/, ''))
        j++
      }
      segments.push({
        kind: 'alert',
        alert: (alert[1] ?? 'NOTE').toUpperCase() as AlertKind,
        body: rewriteOutsideFences(body.join('\n')),
      })
      i = j
      continue
    }

    buffer.push(line)
    i++
  }
  flush()
  return segments
}

export const fnv1a = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export const pngSize = (bytes: Uint8Array): { width: number; height: number } | null => {
  if (bytes.length < 24 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

export const imageCells = (
  px: { width: number; height: number },
  scale: number,
  maxColumns: number,
  cellAspect = 2,
  maxRows = 45,
): { columns: number; rows: number } => {
  const ratio = px.height / px.width
  let columns = Math.min(maxColumns, 255, Math.max(10, Math.ceil(px.width / scale / 8)))
  let rows = Math.round((columns * ratio) / cellAspect)
  if (rows > maxRows) {
    rows = Math.min(255, maxRows)
    columns = Math.max(10, Math.round((rows * cellAspect) / ratio))
  }
  return { columns, rows: Math.max(1, rows) }
}
