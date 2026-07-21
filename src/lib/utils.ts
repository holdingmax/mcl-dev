import { format } from 'date-fns'
import { WRLine } from '../types'

/** Format a number: comma thousands, dot decimal, 1 decimal by default. 3000 → "3,000.0" */
export function fmtNum(n: number | null | undefined, decimals = 1): string {
  if (n == null) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** Format a dollar amount: $1,234.56 */
export function fmtUSD(n: number | null | undefined, decimals = 2): string {
  if (n == null) return '—'
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

export function calculateCBM(l: number | null, w: number | null, h: number | null, qty: number = 1): number | null {
  if (!l || !w || !h) return null
  return parseFloat(((l * w * h * (qty || 1)) / 1_000_000).toFixed(4))
}

export function formatWRDate(dateStr: any): string {
  try {
    // Handle Firestore Timestamp objects
    if (dateStr && typeof dateStr === 'object' && typeof dateStr.toDate === 'function') {
      return format(dateStr.toDate(), 'MM/dd/yy HH:mm:ss')
    }
    return format(new Date(dateStr), 'MM/dd/yy HH:mm:ss')
  } catch {
    return typeof dateStr === 'string' ? dateStr : ''
  }
}

export function computeTotals(lines: WRLine[]) {
  const total_qty = lines.reduce((sum, l) => sum + (l.qty || 0), 0)
  const total_cbm = lines.reduce((sum, l) => sum + (l.cbm || 0), 0)
  const total_weight_kg = lines.reduce((sum, l) => sum + (l.weight_kg || 0), 0)
  return {
    total_qty,
    total_cbm: parseFloat(total_cbm.toFixed(4)),
    total_weight_kg: parseFloat(total_weight_kg.toFixed(2)),
  }
}

const SIGLA_EXCEPTIONS = new Set([
  'S.A.', 'S.A.S.', 'S.A.S', 'LLC', 'LTDA', 'INC', 'CORP', 'S.R.L.', 'C.A.', 'N.V.', 'S.L.',
])

export function toTitleCase(str: string | null | undefined): string {
  if (!str) return str ?? ''
  return str
    .split(/\s+/)
    .map(word => {
      if (!word) return word
      const upper = word.toUpperCase()
      if (SIGLA_EXCEPTIONS.has(upper) || SIGLA_EXCEPTIONS.has(word)) return upper
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(' ')
}

// ── Storage path helpers ─────────────────────────────────────────────────────

/** Sanitize a string for use in Storage paths: remove slashes, colons, etc. */
function sanitize(s: string): string {
  return s.replace(/[\/\\:*?"<>|#\[\]]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').trim()
}

/** Extract YYYY-MM from a datetime string like "2026-04-02T19:00:00" */
function yearMonth(dt: string): string {
  return dt ? dt.slice(0, 7) : 'unknown'
}

/** Extract YYYY-MM-DD from a datetime string */
function dateOnly(dt: string): string {
  return dt ? dt.slice(0, 10) : 'unknown'
}

/**
 * Build a readable Storage path for airfreight documents.
 *
 * Structure:
 *   airfreight/{YYYY-MM}/{FLIGHT_DATE}_{FLIGHT}_{AIRLINE}/{CLIENT}_{MAWB|AWB}/{filename}
 *
 * Examples:
 *   airfreight/2026-04/2026-04-02_LA0543_LATAM/Merflex_MAWB-045-21583170/doc_hawb_17...pdf
 *   airfreight/2026-04/2026-04-02_LA0543_LATAM/Merflex_MAWB-045-21583170/045-21583785/doc_7512_17...pdf
 *   airfreight/2026-04/2026-04-06_QT4091_AVIANCA/ExpressLine_AWB-045-12481795/doc_hawb_17...pdf
 */
export function storagePath(opts: {
  flightNumber?: string
  flightDate?: string      // flight_datetime from Firestore
  airline?: string
  clientName?: string
  mawbNumber?: string      // for MAWB clients
  awbNumber?: string       // for AWB-level docs
  filename: string         // e.g. "doc_7512_1712345678.pdf"
}): string {
  const ym = yearMonth(opts.flightDate || '')
  const dd = dateOnly(opts.flightDate || '')
  const flight = sanitize(opts.flightNumber || 'no-flight')
  const airline = sanitize(opts.airline || 'no-airline')
  const client = sanitize(opts.clientName || 'unknown')
  const identifier = opts.mawbNumber
    ? `MAWB-${sanitize(opts.mawbNumber)}`
    : 'Direct'

  const flightFolder = `${dd}_${flight}_${airline}`
  const clientFolder = `${client}_${identifier}`

  if (opts.awbNumber) {
    return `airfreight/${ym}/${flightFolder}/${clientFolder}/${sanitize(opts.awbNumber)}/${opts.filename}`
  }
  return `airfreight/${ym}/${flightFolder}/${clientFolder}/${opts.filename}`
}

/**
 * Build a readable Storage path for flight-level documents (distribution, DO/TSA).
 *   airfreight/{YYYY-MM}/{FLIGHT_DATE}_{FLIGHT}_{AIRLINE}/{filename}
 */
export function storagePathFlight(opts: {
  flightNumber?: string
  flightDate?: string
  airline?: string
  filename: string
}): string {
  const ym = yearMonth(opts.flightDate || '')
  const dd = dateOnly(opts.flightDate || '')
  const flight = sanitize(opts.flightNumber || 'no-flight')
  const airline = sanitize(opts.airline || 'no-airline')
  return `airfreight/${ym}/${dd}_${flight}_${airline}/${opts.filename}`
}

/**
 * Build a readable Storage path for hold documents.
 *   airfreight/{YYYY-MM}/{FLIGHT_DATE}_{FLIGHT}_{AIRLINE}/holds/{holdId}/{filename}
 */
export function storagePathHold(opts: {
  flightNumber?: string
  flightDate?: string
  airline?: string
  holdId: string
  filename: string
}): string {
  const ym = yearMonth(opts.flightDate || '')
  const dd = dateOnly(opts.flightDate || '')
  const flight = sanitize(opts.flightNumber || 'no-flight')
  const airline = sanitize(opts.airline || 'no-airline')
  return `airfreight/${ym}/${dd}_${flight}_${airline}/holds/${opts.holdId}/${opts.filename}`
}

export function emptyLine(order: number): WRLine {
  return {
    line_order: order,
    packing_type: 'SKID',
    has_lb: false,
    is_dg: false,
    qty: 1,
    length_cm: null,
    width_cm: null,
    height_cm: null,
    cbm: null,
    weight_kg: null,
    location: '',
    remarks: '',
  }
}
