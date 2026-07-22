const { onSchedule } = require('firebase-functions/v2/scheduler')
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https')
const { onDocumentDeleted, onDocumentUpdated, onDocumentCreated } = require('firebase-functions/v2/firestore')
const { defineSecret } = require('firebase-functions/params')
const admin = require('firebase-admin')
const { google } = require('googleapis')
const Anthropic = require('@anthropic-ai/sdk')
const nodemailer = require('nodemailer')
const puppeteerCore = require('puppeteer-core')
const chromium = require('@sparticuz/chromium').default
const mysql = require('mysql2/promise')

admin.initializeApp()

const db = admin.firestore()
const bucket = admin.storage().bucket()

// Secrets
const GMAIL_CLIENT_ID = defineSecret('GMAIL_CLIENT_ID')
const GMAIL_CLIENT_SECRET = defineSecret('GMAIL_CLIENT_SECRET')
const GMAIL_REFRESH_TOKEN = defineSecret('GMAIL_REFRESH_TOKEN')
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY')
const GMAIL_USER = defineSecret('GMAIL_USER')
const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD')
const AV_GMAIL_REFRESH_TOKEN = defineSecret('AV_GMAIL_REFRESH_TOKEN')

// MariaDB (Inmotion) — POC de migracion de facturacion/WR
const MARIADB_HOST = defineSecret('MARIADB_HOST')
const MARIADB_PORT = defineSecret('MARIADB_PORT')
const MARIADB_DATABASE = defineSecret('MARIADB_DATABASE')
const MARIADB_USER = defineSecret('MARIADB_USER')
const MARIADB_PASSWORD = defineSecret('MARIADB_PASSWORD')

// Pool de conexiones a MariaDB, creado una sola vez por instancia "warm" y
// reutilizado entre invocaciones — nunca una conexion nueva por invocacion,
// para no agotar el limite bajo de conexiones concurrentes del hosting compartido.
let mariaDbPool = null
function getMariaDbPool() {
  if (mariaDbPool) return mariaDbPool
  mariaDbPool = mysql.createPool({
    host: MARIADB_HOST.value(),
    port: Number(MARIADB_PORT.value()),
    database: MARIADB_DATABASE.value(),
    user: MARIADB_USER.value(),
    password: MARIADB_PASSWORD.value(),
    connectionLimit: 5,
    waitForConnections: true,
  })
  return mariaDbPool
}

// ── Screening Agent Helpers ────────────────────────────────────────────────

function getGmailClient() {
  const oauth2Client = new google.auth.OAuth2(
    GMAIL_CLIENT_ID.value(),
    GMAIL_CLIENT_SECRET.value(),
    'https://developers.google.com/oauthplayground'
  )
  oauth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN.value() })
  return google.gmail({ version: 'v1', auth: oauth2Client })
}

function getSmtpTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER.value(),
      pass: GMAIL_APP_PASSWORD.value(),
    },
  })
}

/**
 * Extract plain-text body from Gmail message payload (recursive).
 */
function decodeBody(data) {
  if (!data) return ''
  const raw = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(raw, 'base64').toString('utf-8')
}

function stripHtml(html) {
  return html
    // Drop script/style blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Convert <br> and </p> to newlines so the regex line detection still works
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    // Strip all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    // Collapse excessive whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
}

function findPlainTextPart(payload) {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBody(payload.body.data)
  }
  for (const part of (payload.parts || [])) {
    const text = findPlainTextPart(part)
    if (text) return text
  }
  return ''
}

function findHtmlPart(payload) {
  if (!payload) return ''
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBody(payload.body.data)
  }
  for (const part of (payload.parts || [])) {
    const html = findHtmlPart(part)
    if (html) return html
  }
  return ''
}

function getEmailBodyText(payload) {
  // Prefer text/plain; fall back to stripped text/html for HTML-only emails
  // (Phantom K9 originals are HTML-only; Outlook/Gmail Fwd: adds a text/plain copy)
  const plain = findPlainTextPart(payload)
  if (plain) return plain
  const html = findHtmlPart(payload)
  if (html) return stripHtml(html)
  return ''
}

/**
 * Parse screening data from Phantom K9 email body text.
 * Returns same structure as the old Claude Vision extraction for compatibility.
 */
function parseEmailBody(bodyText) {
  // MCL Representative: "Dear Alejandro Garcia,"
  const repMatch = bodyText.match(/Dear\s+([A-Za-z\u00C0-\u00FF]+(?:\s+[A-Za-z\u00C0-\u00FF]+)+)\s*[,.]/)
  const mcl_representant = repMatch ? repMatch[1].trim() : ''

  // Screened Date/Time: "04/09/2026 20:26:47 (EST)"
  const dateMatch = bodyText.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):\d{2}/)
  const date = dateMatch ? `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}` : ''
  const time = dateMatch ? `${dateMatch[4]}:${dateMatch[5]}` : ''

  // Phantom Screener: name after "Thank you!" before certification line
  const screenerMatch = bodyText.match(/Thank\s*you!?\s*[\r\n\s]+([A-Za-z\u00C0-\u00FF]+(?:\s+[A-Za-z\u00C0-\u00FF]+)+)\s*[\r\n]/)
  // Fallback: look for name right before "President of Operations" or "Certified Handler"
  const screenerFallback = !screenerMatch && bodyText.match(/\n\s*([A-Za-z\u00C0-\u00FF]+(?:\s+[A-Za-z\u00C0-\u00FF]+)+)\s*\n[^\n]*(?:President|Certified|Operations|Phantom\s*K9)/i)
  const phantom_screener = screenerMatch ? screenerMatch[1].trim() : (screenerFallback ? screenerFallback[1].trim() : '')

  // AWB lines — unified regex handles all Phantom K9 formats:
  // "045–21532291 FQA 11546R7 : (20 PCS)"   — space, colon, PCS
  // "045–12481795 PAG63853R7 (89 PC / 89 PC)" — no space, no colon, PC
  // "045-21583203 196-00143006 (89 PC / 89 PC)" — container serial
  // "04522208977 PAG67268R7 : (69 PCS)"       — NO dash between prefix and serial
  const uld_lines = []
  // Pattern 1: AWB with explicit dash/en-dash between prefix and serial
  const lineRegex = /(\d{3})[\u2013\u2014\u2012\-]\s*([\d][\d ]{6,10}\d)\s+([A-Z]{2,4}[\s\w]+?)\s*:?\s*\((\d+)\s*(?:PCS|PC)/gi
  let m
  while ((m = lineRegex.exec(bodyText)) !== null) {
    const awbSerial = m[2].replace(/\s/g, '')
    const uldInfo = m[3].trim()
    const uldParts = uldInfo.match(/^([A-Z]{2,4})\s*([\w\-]+)$/i)
    uld_lines.push({
      awb: `${m[1]}-${awbSerial}`,
      uld_type: uldParts ? uldParts[1] : '',
      uld_number: uldParts ? uldParts[2] : uldInfo,
      pieces: parseInt(m[4]),
    })
  }
  // Pattern 2: ULD comes BEFORE AWB, AWB has no standard prefix dash, with parentheses.
  // Formats seen in some Phantom K9 emails:
  //   "PG63705R7 04522208977 : (72 PCS)"      — ULD_TYPE+NUMBER AWB
  //   "PMC 20686R7 04522208970 : (70 PCS)"     — ULD_TYPE NUMBER AWB
  //   "PMC 61156 AA 0452220-8970 : (12 PCS)"   — ULD_TYPE NUMBER SUFFIX AWB_with_misplaced_dash
  // Only runs if Pattern 1 found nothing (avoid double-capture)
  if (uld_lines.length === 0) {
    const reversedRegex = /([A-Z]{2,4})\s*([\w]+(?:\s+[A-Z]{1,2})?)\s+(\d[\d\- ]{8,12}\d)\s*:?\s*\((\d+)\s*(?:PCS|PC)/gi
    while ((m = reversedRegex.exec(bodyText)) !== null) {
      const uldType = m[1]
      const uldNumber = m[2].trim()
      const rawAwb = m[3].replace(/[\s\-]/g, '') // strip spaces/dashes → pure digits
      // Insert dash after first 3 digits: "04522208977" → "045-22208977"
      const awbFormatted = rawAwb.length >= 4 ? rawAwb.slice(0, 3) + '-' + rawAwb.slice(3) : rawAwb
      uld_lines.push({
        awb: awbFormatted,
        uld_type: uldType,
        uld_number: uldNumber,
        pieces: parseInt(m[4]),
      })
    }
  }

  // Pattern 3: Comma-separated, NO parentheses — newer Phantom K9 format
  // 3a: ULD first — "PAG72202R7 84, 045–22209655 84 PCS"
  //                  "PMC 46265QT 86, 729–93889305 86 PCS"
  //                  "PMC 41861QT 93, 729–9 3889423 93 PCS"  (space within AWB serial)
  // 3b: AWB first — "045– 22417080 1225, PAG62640R7 89 PCS"
  //                  "045–22417415 650, PAG61728R7 83 PCS"
  if (uld_lines.length === 0) {
    // 3a: ULD TOTAL, AWB PIECES PCS  (AWB serial may contain spaces)
    const commaUldFirst = /([A-Z]{2,4})\s*([\w]+(?:\s+[\w]+)?)\s+\d+,\s*(\d{3})[\u2013\u2014\u2012\-]\s*(\d[\d ]{3,10}\d)\s+(\d+)\s*(?:PCS|PC)/gi
    while ((m = commaUldFirst.exec(bodyText)) !== null) {
      const awbSerial = m[4].replace(/\s/g, '')
      uld_lines.push({
        awb: `${m[3]}-${awbSerial}`,
        uld_type: m[1],
        uld_number: m[2].trim(),
        pieces: parseInt(m[5]),
      })
    }
    // 3b: AWB TOTAL, ULD PIECES PCS  (AWB serial may contain spaces)
    if (uld_lines.length === 0) {
      const commaAwbFirst = /(\d{3})[\u2013\u2014\u2012\-]\s*(\d[\d ]{3,10}\d)\s+\d+,\s*([A-Z]{2,4})\s*([\w]+)\s+(\d+)\s*(?:PCS|PC)/gi
      while ((m = commaAwbFirst.exec(bodyText)) !== null) {
        const awbSerial = m[2].replace(/\s/g, '')
        uld_lines.push({
          awb: `${m[1]}-${awbSerial}`,
          uld_type: m[3],
          uld_number: m[4].trim(),
          pieces: parseInt(m[5]),
        })
      }
    }
  }

  // Pattern 4: Comma-separated, AWB has NO dash at all — plain digits
  // "PMC 43623QT 55, 72995079003 30 PCS"
  // "PMC 02861JE 37, 90613445180 3 PCS"
  // "PMC 46331QT 51, 906-134-45165 2 PCS" (dash in wrong place)
  if (uld_lines.length === 0) {
    const noDelimRegex = /([A-Z]{2,4})\s*([\w]+)\s+\d+,\s*(\d[\d\- ]{7,12}\d)\s+(\d+)\s*(?:PCS|PC)/gi
    while ((m = noDelimRegex.exec(bodyText)) !== null) {
      const rawAwb = m[3].replace(/[\s\-]/g, '') // strip ALL spaces and dashes
      const awbFormatted = rawAwb.length >= 4 ? rawAwb.slice(0, 3) + '-' + rawAwb.slice(3) : rawAwb
      uld_lines.push({
        awb: awbFormatted,
        uld_type: m[1],
        uld_number: m[2].trim(),
        pieces: parseInt(m[4]),
      })
    }
  }

  // TSA Regulated Entry: "Tampa Cargo/ ACISP-3PK9-18-01C" or similar
  const tsaMatch = bodyText.match(/(?:TSA\s*(?:Regulated)?\s*(?:Entry|Entity|Facility)[\s:]*|Cargo\s*Transfer\s*Certificate[\s\S]{0,200}?)([\w\s]+\/\s*[A-Z0-9\-]+(?:PK9|ACISP|CCSP)[A-Z0-9\-]*)/i)
    || bodyText.match(/([\w\s]+\/\s*ACISP[A-Z0-9\-]+)/i)
    || bodyText.match(/(Tampa\s+Cargo\s*\/\s*[A-Z0-9\-]+)/i)
  const tsa_entry = tsaMatch ? tsaMatch[1].trim() : ''

  return { date, time, phantom_screener, mcl_representant, tsa_entry, uld_lines }
}

/**
 * Group uld_lines by AWB number.
 * Returns array of { awb, uld_lines, pieces }
 */
function groupByAwb(extracted) {
  const groups = {}
  for (const line of (extracted.uld_lines || [])) {
    const rawAwb = (line.awb || '').trim()
    if (!rawAwb) continue
    const key = normalizeAwb(rawAwb)
    if (!key) continue
    if (!groups[key]) groups[key] = { awb: rawAwb, uld_lines: [], pieces: 0 }
    groups[key].uld_lines.push(line)
    groups[key].pieces += (parseInt(line.pieces) || 0)
  }
  return Object.values(groups)
}

/**
 * Normalize AWB number: strip dashes, en-dashes, em-dashes, spaces.
 * "045–21584124" / "045-21584124" / "04521584124" all become "04521584124"
 */
function normalizeAwb(awb) {
  return (awb || '')
    .replace(/[\s\-\u2013\u2014]/g, '')  // strip dashes, spaces
    .replace(/[Oo]/g, '0')                // normalize O/o → 0 (OCR confusion)
    .trim()
}

/** Normalize AWB for indexed search (matches frontend awbNormalize.ts) */
function normalizeAwbForIndex(val) {
  return (val || '').replace(/[^A-Z0-9]/gi, '').toUpperCase()
}

/** Compute awb_numbers_normalized array for a booking (matches frontend) */
function computeAwbNumbersNormalized(bookingData) {
  const set = new Set()
  if (bookingData.booking_type === 'simple') {
    if (bookingData.awb_1st_leg) set.add(normalizeAwbForIndex(bookingData.awb_1st_leg))
    if (bookingData.awb_2nd_leg) set.add(normalizeAwbForIndex(bookingData.awb_2nd_leg))
  } else {
    for (const line of bookingData.awb_lines || []) {
      if (line.awb_number) set.add(normalizeAwbForIndex(line.awb_number))
      if (line.awb_2nd_leg) set.add(normalizeAwbForIndex(line.awb_2nd_leg))
    }
  }
  set.delete('')
  return Array.from(set)
}

/**
 * Find matching booking by AWB line or MAWB.
 * Priority: 1) exact AWB line match  2) MAWB match (covers all lines)
 * Returns { booking, bookingId, flightId, matchMethod, awbLineIndex }
 *   awbLineIndex >= 0  → single line match
 *   awbLineIndex === -1 AND matchMethod === 'mawb' → MAWB match, apply to ALL lines
 */
async function findMatchingBooking(extracted) {
  const awb = (extracted.awb || '').trim()
  const normAwb = normalizeAwb(awb)

  // Helper: find awb_line index by normalized AWB within a booking
  function findLineIndex(booking, norm) {
    if (!booking.awb_lines || !norm) return -1
    return booking.awb_lines.findIndex(
      (line) => normalizeAwb(line.awb_2nd_leg) === norm ||
                normalizeAwb(line.awb_number) === norm
    )
  }

  if (!normAwb) return null

  // 1. Try matching by awb_2nd_leg / awb_number in awb_lines (exact line match)
  const allSnap = await db.collection('airfreight_bookings').get()
  for (const doc of allSnap.docs) {
    const booking = doc.data()
    const idx = findLineIndex(booking, normAwb)
    if (idx >= 0) {
      const matchedLine = booking.awb_lines[idx]
      const matchedVia = normalizeAwb(matchedLine.awb_2nd_leg) === normAwb ? 'awb_2nd_leg' : 'awb_number'
      const matchedLineAwb = matchedVia === 'awb_2nd_leg' ? matchedLine.awb_2nd_leg : matchedLine.awb_number
      console.log(`findMatchingBooking: cert AWB "${awb}" matched booking ${doc.id} (client: ${booking.client_name}) via line[${idx}].${matchedVia}="${matchedLineAwb}" (MAWB: ${booking.mawb_number || 'none'})`)

      // Check if multiple lines share the same AWB — if so, treat as MAWB-style
      // match (apply to ALL lines) instead of picking just the first one.
      const matchCount = (booking.awb_lines || []).filter(
        (line) => normalizeAwb(line.awb_2nd_leg) === normAwb || normalizeAwb(line.awb_number) === normAwb
      ).length
      if (matchCount > 1) {
        return {
          booking,
          bookingId: doc.id,
          flightId: booking.flight_id,
          matchMethod: 'mawb',
          awbLineIndex: -1, // multiple lines share this AWB → treat as MAWB
          matchedVia: `${matchCount} lines share ${matchedVia}`,
          matchedLineAwb,
        }
      }
      return {
        booking,
        bookingId: doc.id,
        flightId: booking.flight_id,
        matchMethod: 'awb_2nd_leg',
        awbLineIndex: idx,
        matchedVia,
        matchedLineAwb,
      }
    }
  }

  // 1b. Try matching by awb_2nd_leg / awb_1st_leg at BOOKING level (simple bookings — no awb_lines)
  for (const doc of allSnap.docs) {
    const booking = doc.data()
    if (booking.booking_type !== 'simple') continue
    const norm2nd = normalizeAwb(booking.awb_2nd_leg)
    const norm1st = normalizeAwb(booking.awb_1st_leg)
    if (norm2nd === normAwb || norm1st === normAwb) {
      const matchedVia = norm2nd === normAwb ? 'awb_2nd_leg' : 'awb_1st_leg'
      const matchedLineAwb = matchedVia === 'awb_2nd_leg' ? booking.awb_2nd_leg : booking.awb_1st_leg
      console.log(`findMatchingBooking: cert AWB "${awb}" matched SIMPLE booking ${doc.id} (client: ${booking.client_name}) via booking.${matchedVia}="${matchedLineAwb}"`)
      return {
        booking,
        bookingId: doc.id,
        flightId: booking.flight_id,
        matchMethod: 'simple_booking',
        awbLineIndex: -2, // -2 = simple booking (no awb_lines)
        matchedVia,
        matchedLineAwb,
      }
    }
  }

  // 2. Try matching by MAWB number (ecommerce/Merflex — cert lists the MAWB)
  for (const doc of allSnap.docs) {
    const booking = doc.data()
    if (booking.mawb_number && normalizeAwb(booking.mawb_number) === normAwb) {
      console.log(`findMatchingBooking: cert AWB "${awb}" matched booking ${doc.id} (client: ${booking.client_name}) via mawb_number="${booking.mawb_number}"`)
      return {
        booking,
        bookingId: doc.id,
        flightId: booking.flight_id,
        matchMethod: 'mawb',
        awbLineIndex: -1, // means: apply to ALL lines
        matchedVia: 'mawb_number',
        matchedLineAwb: booking.mawb_number,
      }
    }
  }

  // 3. No exact match — look for near-matches (1-2 digit difference, e.g. transposed digits)
  // These go to "unmatched" but with a suggestion for manual correction
  const nearMatches = []
  for (const doc of allSnap.docs) {
    const booking = doc.data()
    if (!booking.awb_lines) continue
    for (let i = 0; i < booking.awb_lines.length; i++) {
      const line = booking.awb_lines[i]
      for (const field of ['awb_2nd_leg', 'awb_number']) {
        const lineAwb = normalizeAwb(line[field])
        if (!lineAwb || lineAwb.length !== normAwb.length) continue
        const diff = countDiffChars(normAwb, lineAwb)
        if (diff > 0 && diff <= 2) {
          nearMatches.push({
            bookingId: doc.id,
            clientName: booking.client_name || '',
            lineIndex: i,
            field,
            systemAwb: line[field],
            distance: diff,
          })
        }
      }
    }
    // Also check simple booking AWBs
    if (booking.booking_type === 'simple') {
      for (const field of ['awb_2nd_leg', 'awb_1st_leg']) {
        const bAwb = normalizeAwb(booking[field])
        if (!bAwb || bAwb.length !== normAwb.length) continue
        const diff = countDiffChars(normAwb, bAwb)
        if (diff > 0 && diff <= 2) {
          nearMatches.push({
            bookingId: doc.id,
            clientName: booking.client_name || '',
            lineIndex: -2,
            field,
            systemAwb: booking[field],
            distance: diff,
          })
        }
      }
    }
    // Also check mawb_number
    if (booking.mawb_number) {
      const normMawb = normalizeAwb(booking.mawb_number)
      if (normMawb.length === normAwb.length) {
        const diff = countDiffChars(normAwb, normMawb)
        if (diff > 0 && diff <= 2) {
          nearMatches.push({
            bookingId: doc.id,
            clientName: booking.client_name || '',
            lineIndex: -1,
            field: 'mawb_number',
            systemAwb: booking.mawb_number,
            distance: diff,
          })
        }
      }
    }
  }

  if (nearMatches.length > 0) {
    // Sort by distance (closest first)
    nearMatches.sort((a, b) => a.distance - b.distance)
    const suggestions = nearMatches.slice(0, 3).map(nm =>
      `${nm.systemAwb} (${nm.clientName}, ${nm.field}, ${nm.distance} char diff)`
    ).join('; ')
    console.log(`findMatchingBooking: cert AWB "${awb}" UNMATCHED but near-matches found: ${suggestions}`)
    return {
      booking: null,
      bookingId: null,
      flightId: null,
      matchMethod: 'unmatched',
      awbLineIndex: -1,
      nearMatches,
      nearMatchSuggestion: suggestions,
    }
  }

  return null
}

/**
 * Count character differences between two strings of equal length.
 * Used for near-match detection (transposed digits, typos).
 */
function countDiffChars(a, b) {
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diff++
  }
  return diff
}

/**
 * Calculate booking-level screening totals from awb_lines.
 * Always derives booking totals from the sum of line-level data.
 */
function calcBookingScreeningTotals(awbLines) {
  if (!awbLines || awbLines.length === 0) return { totalScreened: 0, totalBooking: 0, status: 'pending' }

  const totalScreened = awbLines.reduce((s, l) => s + (l.screening_pieces_screened || 0), 0)
  const totalBooking = awbLines.reduce((s, l) => s + (l.pieces || 0), 0)

  let status = 'pending'
  if (totalScreened > totalBooking) status = 'error'
  else if (totalScreened === totalBooking && totalScreened > 0) status = 'complete'
  else if (totalScreened > 0) status = 'partial'

  return { totalScreened, totalBooking, status }
}

/**
 * Send error alert email to Phantom K9 contacts.
 */
async function sendErrorAlert(settings, eventData, errorReason) {
  if (!settings.phantom_k9_emails || settings.phantom_k9_emails.length === 0) return

  const transport = getSmtpTransport()
  const subject = `[URGENT] Screening Error - ${eventData.extracted.mawb || eventData.extracted.awb}`
  const html = `
    <h2>Screening Certificate Error</h2>
    <p><strong>Error:</strong> ${errorReason}</p>
    <p><strong>MAWB:</strong> ${eventData.extracted.mawb || '—'}</p>
    <p><strong>AWB:</strong> ${eventData.extracted.awb || '—'}</p>
    <p><strong>Pieces in certificate:</strong> ${eventData.extracted.pieces}</p>
    <p><strong>Date:</strong> ${eventData.extracted.date}</p>
    <p><strong>PDF:</strong> ${eventData.pdf_filename}</p>
    <hr>
    <p>This is an automated message from MCL WMS Screening Agent.</p>
  `

  await transport.sendMail({
    from: GMAIL_USER.value(),
    to: settings.phantom_k9_emails.join(','),
    cc: (settings.mcl_alert_emails || []).join(','),
    subject,
    html,
  })
}

// ── deleteClientUser (onCall v2) — delete user from Auth + Firestore ────

exports.deleteClientUser = onCall({
  timeoutSeconds: 30,
  memory: '256MiB',
  invoker: 'public',
}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be logged in')
  const callerEmail = request.auth.token.email || ''
  if (!callerEmail.endsWith('@mincurllogistics.com')) throw new HttpsError('permission-denied', 'MCL only')

  const { uid } = request.data || {}
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required')

  // Delete from Firebase Auth
  try {
    await admin.auth().deleteUser(uid)
  } catch (err) {
    if (err.code !== 'auth/user-not-found') {
      console.error('Error deleting auth user:', err)
      throw new HttpsError('internal', 'Failed to delete auth user: ' + err.message)
    }
  }

  // Delete from user_roles
  try {
    await db.doc(`user_roles/${uid}`).delete()
  } catch (err) {
    console.error('Error deleting user_roles doc:', err)
  }

  console.log(`User ${uid} deleted by ${callerEmail}`)
  return { success: true, uid }
})

// ── getScreeningPdf (onCall) — proxy to serve PDFs via Admin SDK ─────────

exports.getScreeningPdf = onCall({
  timeoutSeconds: 30,
  memory: '256MiB',
}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be logged in')
  const email = request.auth.token.email || ''
  if (!email.endsWith('@mincurllogistics.com')) throw new HttpsError('permission-denied', 'MCL only')

  const path = request.data.path
  if (!path || !path.startsWith('airfreight/screening-certs/')) {
    throw new HttpsError('invalid-argument', 'Invalid path')
  }

  const file = bucket.file(path)
  const [exists] = await file.exists()
  if (!exists) throw new HttpsError('not-found', 'File not found')

  const [buffer] = await file.download()
  return { data: buffer.toString('base64') }
})

// ── resetScreeningData (onCall) — reset screening data, optionally from a date ───
// Also supports mode: 'deleteEvents' to delete specific events and recalculate

exports.resetScreeningData = onCall({
  timeoutSeconds: 120,
  memory: '512MiB',
}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be logged in')
  const email = request.auth.token.email || ''
  if (!email.endsWith('@mincurllogistics.com')) throw new HttpsError('permission-denied', 'MCL only')

  // ── Mode: recalculate — rebuild booking screening data from existing events ──
  if (request.data?.mode === 'recalculate') {
    console.log('Recalculate mode: rebuilding booking screening data from events')

    // Get all non-duplicate, non-unmatched events that have a matched booking
    const allEventsSnap = await db.collection('screening_events').get()
    const eventsByBooking = new Map()
    for (const d of allEventsSnap.docs) {
      const ev = d.data()
      if (!ev.matched_booking_id) continue
      if (ev.status === 'duplicate') continue
      if (!eventsByBooking.has(ev.matched_booking_id)) eventsByBooking.set(ev.matched_booking_id, [])
      eventsByBooking.get(ev.matched_booking_id).push({ id: d.id, ...ev })
    }

    let recalculated = 0
    for (const [bookingId, events] of eventsByBooking) {
      const bDoc = await db.collection('airfreight_bookings').doc(bookingId).get()
      if (!bDoc.exists) continue
      const bData = bDoc.data()

      const keptEventIds = events.map(e => e.id)
      let lines = bData.awb_lines ? [...bData.awb_lines] : []

      // Clear existing screening data from lines
      lines = lines.map(line => {
        const { screening_status, screening_pieces_screened, doc_screening_cert, screening_details, ...rest } = line
        return rest
      })

      let bookingLevelPieces = 0
      let isMawbBooking = false
      let isSimpleBooking = bData.booking_type === 'simple'
      let simpleBookingCert = null
      let simpleBookingDetails = null

      for (const ev of events) {
        const evAwb = ev.extracted?.awb || ''
        const evPieces = ev.extracted?.pieces || 0

        if (isSimpleBooking || ev.match_method === 'simple_booking') {
          // Simple booking: data at booking level
          bookingLevelPieces += evPieces
          isSimpleBooking = true
          if (ev.pdf_url) {
            simpleBookingCert = { url: ev.pdf_url, filename: ev.pdf_filename || '', uploaded_at: ev.processed_at || '', uploaded_by: 'screening-agent', modified_seen: false, version: 1, history: [] }
          }
          if (ev.extracted) {
            simpleBookingDetails = { mawb: ev.extracted.mawb || evAwb, awb: evAwb, date: ev.extracted.date || '', time: ev.extracted.time || '', phantom_screener: ev.extracted.phantom_screener || '', mcl_representant: ev.extracted.mcl_representant || '', uld: ev.extracted.uld || '', pieces: evPieces }
          }
        } else if (ev.match_method === 'mawb') {
          isMawbBooking = true
          bookingLevelPieces += evPieces
        } else {
          // Line match
          const normEvAwb = normalizeAwb(evAwb)
          const lineIdx = lines.findIndex(l =>
            normalizeAwb(l.awb_2nd_leg) === normEvAwb || normalizeAwb(l.awb_number) === normEvAwb
          )
          if (lineIdx >= 0) {
            const line = { ...lines[lineIdx] }
            line.screening_pieces_screened = (line.screening_pieces_screened || 0) + evPieces
            if (ev.pdf_url) {
              line.doc_screening_cert = { url: ev.pdf_url, filename: ev.pdf_filename || '', uploaded_at: ev.processed_at || '', uploaded_by: 'screening-agent', modified_seen: false, version: 1, history: [] }
            }
            if (ev.extracted) {
              line.screening_details = { mawb: ev.extracted.mawb || bData.mawb_number || evAwb, awb: evAwb, date: ev.extracted.date || '', time: ev.extracted.time || '', phantom_screener: ev.extracted.phantom_screener || '', mcl_representant: ev.extracted.mcl_representant || '', uld: ev.extracted.uld || '', pieces: evPieces }
            }
            lines[lineIdx] = line
          }
        }
      }

      if (isSimpleBooking) {
        const bkPieces = bData.pieces || 0
        let status = 'pending'
        if (bookingLevelPieces > bkPieces) status = 'error'
        else if (bookingLevelPieces === bkPieces && bookingLevelPieces > 0) status = 'complete'
        else if (bookingLevelPieces > 0) status = 'partial'
        const update = { screening_events: keptEventIds, screening_status: status, screening_pieces_total: bookingLevelPieces }
        if (simpleBookingCert) update.doc_screening_cert = simpleBookingCert
        if (simpleBookingDetails) update.screening_details = simpleBookingDetails
        await bDoc.ref.update(update)
      } else if (isMawbBooking) {
        const bkPieces = lines.length > 0 ? lines.reduce((s, l) => s + (l.pieces || 0), 0) : (bData.pieces || 0)
        let status = 'pending'
        if (bookingLevelPieces > bkPieces) status = 'error'
        else if (bookingLevelPieces === bkPieces && bookingLevelPieces > 0) status = 'complete'
        else if (bookingLevelPieces > 0) status = 'partial'
        await bDoc.ref.update({ screening_events: keptEventIds, screening_status: status, screening_pieces_total: bookingLevelPieces, awb_lines: lines })
      } else {
        // Line-level recalculation
        lines = lines.map(line => {
          const screened = line.screening_pieces_screened || 0
          const total = line.pieces || 0
          if (screened <= 0) return line
          let st = 'pending'
          if (screened > total) st = 'error'
          else if (screened === total) st = 'complete'
          else st = 'partial'
          return { ...line, screening_status: st }
        })
        const totals = calcBookingScreeningTotals(lines)
        await bDoc.ref.update({ screening_events: keptEventIds, screening_status: totals.status, screening_pieces_total: totals.totalScreened, awb_lines: lines })
      }

      recalculated++
    }

    console.log(`Recalculate: rebuilt ${recalculated} bookings from ${allEventsSnap.size} events`)
    return { recalculated, totalEvents: allEventsSnap.size }
  }

  // ── Mode: deleteEvents — delete specific screening events and recalculate ──
  if (request.data?.mode === 'deleteEvents') {
    const eventIds = request.data?.eventIds
    if (!eventIds || !Array.isArray(eventIds) || eventIds.length === 0) {
      throw new HttpsError('invalid-argument', 'eventIds must be a non-empty array')
    }

    // 1. Read events to get affected booking IDs
    const affectedBookings = new Map()
    for (const eid of eventIds) {
      const snap = await db.collection('screening_events').doc(eid).get()
      if (!snap.exists) continue
      const ev = snap.data()
      if (ev.matched_booking_id) {
        if (!affectedBookings.has(ev.matched_booking_id)) affectedBookings.set(ev.matched_booking_id, [])
        affectedBookings.get(ev.matched_booking_id).push(eid)
      }
    }

    // 2. Delete events
    const delBatch = db.batch()
    for (const eid of eventIds) {
      delBatch.delete(db.collection('screening_events').doc(eid))
    }
    await delBatch.commit()

    // 3. Recalculate each affected booking from remaining events
    for (const [bookingId] of affectedBookings) {
      const bDoc = await db.collection('airfreight_bookings').doc(bookingId).get()
      if (!bDoc.exists) continue
      const bData = bDoc.data()

      const remainingSnap = await db.collection('screening_events')
        .where('matched_booking_id', '==', bookingId)
        .get()
      const remainingEvents = remainingSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(e => e.status !== 'duplicate')

      if (remainingEvents.length === 0) {
        const update = {
          screening_status: admin.firestore.FieldValue.delete(),
          screening_pieces_total: admin.firestore.FieldValue.delete(),
          screening_events: admin.firestore.FieldValue.delete(),
        }
        if (bData.awb_lines) {
          update.awb_lines = bData.awb_lines.map(line => {
            const { screening_status, screening_pieces_screened, doc_screening_cert, screening_details, ...rest } = line
            return rest
          })
        }
        await bDoc.ref.update(update)
      } else {
        const keptEventIds = remainingSnap.docs.map(d => d.id)
        let lines = bData.awb_lines ? [...bData.awb_lines] : []
        lines = lines.map(line => {
          const { screening_status, screening_pieces_screened, doc_screening_cert, screening_details, ...rest } = line
          return rest
        })

        let bookingLevelPieces = 0
        let isMawbBooking = false
        for (const ev of remainingEvents) {
          const evAwb = ev.extracted?.awb || ''
          const evPieces = ev.extracted?.pieces || 0
          if (ev.match_method === 'mawb') {
            isMawbBooking = true
            bookingLevelPieces += evPieces
          } else {
            const normEvAwb = normalizeAwb(evAwb)
            const lineIdx = lines.findIndex(l =>
              normalizeAwb(l.awb_2nd_leg) === normEvAwb || normalizeAwb(l.awb_number) === normEvAwb
            )
            if (lineIdx >= 0) {
              const line = { ...lines[lineIdx] }
              line.screening_pieces_screened = (line.screening_pieces_screened || 0) + evPieces
              if (ev.pdf_url) {
                line.doc_screening_cert = { url: ev.pdf_url, filename: ev.pdf_filename || '', uploaded_at: ev.processed_at || '', uploaded_by: 'screening-agent', modified_seen: false, version: 1, history: [] }
              }
              if (ev.extracted) {
                line.screening_details = { mawb: ev.extracted.mawb || bData.mawb_number || evAwb, awb: evAwb, date: ev.extracted.date || '', time: ev.extracted.time || '', phantom_screener: ev.extracted.phantom_screener || '', mcl_representant: ev.extracted.mcl_representant || '', uld: ev.extracted.uld || '', pieces: evPieces }
              }
              lines[lineIdx] = line
            }
          }
        }

        if (isMawbBooking) {
          const bkPieces = lines.length > 0 ? lines.reduce((s, l) => s + (l.pieces || 0), 0) : (bData.pieces || 0)
          let status = 'pending'
          if (bookingLevelPieces > bkPieces) status = 'error'
          else if (bookingLevelPieces === bkPieces && bookingLevelPieces > 0) status = 'complete'
          else if (bookingLevelPieces > 0) status = 'partial'
          await bDoc.ref.update({ screening_events: keptEventIds, screening_status: status, screening_pieces_total: bookingLevelPieces, awb_lines: lines })
        } else {
          lines = lines.map(line => {
            const screened = line.screening_pieces_screened || 0
            const total = line.pieces || 0
            if (screened <= 0) return line
            let st = 'pending'
            if (screened > total) st = 'error'
            else if (screened === total) st = 'complete'
            else st = 'partial'
            return { ...line, screening_status: st }
          })
          const totals = calcBookingScreeningTotals(lines)
          await bDoc.ref.update({ screening_events: keptEventIds, screening_status: totals.status, screening_pieces_total: totals.totalScreened, awb_lines: lines })
        }
      }
    }

    console.log(`Deleted ${eventIds.length} screening events, recalculated ${affectedBookings.size} bookings`)
    return { deleted: eventIds.length, bookingsRecalculated: affectedBookings.size }
  }

  // ── Mode: standard reset (fromDate or full) ──
  const fromDate = request.data?.fromDate || null // "YYYY-MM-DD" or null for all

  // 1. Get screening_events to delete
  let eventsQuery = db.collection('screening_events')
  if (fromDate) {
    eventsQuery = eventsQuery.where('processed_at', '>=', fromDate)
  }
  const eventsSnap = await eventsQuery.get()

  // Collect affected booking IDs before deleting events
  const affectedBookingIds = new Set()
  eventsSnap.docs.forEach(d => {
    const data = d.data()
    if (data.matched_booking_id) affectedBookingIds.add(data.matched_booking_id)
  })

  // Delete events in batches of 500
  const eventDocs = eventsSnap.docs
  for (let i = 0; i < eventDocs.length; i += 500) {
    const batch = db.batch()
    eventDocs.slice(i, i + 500).forEach(d => batch.delete(d.ref))
    await batch.commit()
  }

  // 2. Clean screening fields from affected bookings
  let bookingsCleaned = 0
  if (fromDate) {
    // Rebuild each affected booking from its REMAINING events (not wiped ones).
    // This preserves screening data from events BEFORE fromDate.
    for (const bookingId of affectedBookingIds) {
      const bDoc = await db.collection('airfreight_bookings').doc(bookingId).get()
      if (!bDoc.exists) continue
      const bData = bDoc.data()

      // Get remaining events for this booking (the ones NOT deleted)
      const remainingSnap = await db.collection('screening_events')
        .where('matched_booking_id', '==', bookingId)
        .get()
      const remainingEvents = remainingSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(e => e.status !== 'duplicate')

      if (remainingEvents.length === 0) {
        // No events left — clear all screening data
        const update = {
          screening_status: admin.firestore.FieldValue.delete(),
          screening_pieces_total: admin.firestore.FieldValue.delete(),
          screening_events: admin.firestore.FieldValue.delete(),
        }
        if (bData.awb_lines) {
          update.awb_lines = bData.awb_lines.map(line => {
            const { screening_status, screening_pieces_screened, doc_screening_cert, screening_details, ...rest } = line
            return rest
          })
        }
        await bDoc.ref.update(update)
      } else {
        // Rebuild from remaining events
        const keptEventIds = remainingEvents.map(e => e.id)
        let lines = bData.awb_lines ? [...bData.awb_lines] : []
        // Clear existing screening data from lines
        lines = lines.map(line => {
          const { screening_status, screening_pieces_screened, doc_screening_cert, screening_details, ...rest } = line
          return rest
        })

        let bookingLevelPieces = 0
        let isMawbBooking = false
        let isSimpleBooking = bData.booking_type === 'simple'
        let simpleBookingCert = null
        let simpleBookingDetails = null

        for (const ev of remainingEvents) {
          const evAwb = ev.extracted?.awb || ''
          const evPieces = ev.extracted?.pieces || 0

          if (isSimpleBooking || ev.match_method === 'simple_booking') {
            bookingLevelPieces += evPieces
            isSimpleBooking = true
            if (ev.pdf_url) {
              simpleBookingCert = { url: ev.pdf_url, filename: ev.pdf_filename || '', uploaded_at: ev.processed_at || '', uploaded_by: 'screening-agent', modified_seen: false, version: 1, history: [] }
            }
            if (ev.extracted) {
              simpleBookingDetails = { mawb: ev.extracted.mawb || evAwb, awb: evAwb, date: ev.extracted.date || '', time: ev.extracted.time || '', phantom_screener: ev.extracted.phantom_screener || '', mcl_representant: ev.extracted.mcl_representant || '', uld: ev.extracted.uld || '', pieces: evPieces }
            }
          } else if (ev.match_method === 'mawb') {
            isMawbBooking = true
            bookingLevelPieces += evPieces
          } else {
            const normEvAwb = normalizeAwb(evAwb)
            const lineIdx = lines.findIndex(l =>
              normalizeAwb(l.awb_2nd_leg) === normEvAwb || normalizeAwb(l.awb_number) === normEvAwb
            )
            if (lineIdx >= 0) {
              const line = { ...lines[lineIdx] }
              line.screening_pieces_screened = (line.screening_pieces_screened || 0) + evPieces
              if (ev.pdf_url) {
                line.doc_screening_cert = { url: ev.pdf_url, filename: ev.pdf_filename || '', uploaded_at: ev.processed_at || '', uploaded_by: 'screening-agent', modified_seen: false, version: 1, history: [] }
              }
              if (ev.extracted) {
                line.screening_details = { mawb: ev.extracted.mawb || bData.mawb_number || evAwb, awb: evAwb, date: ev.extracted.date || '', time: ev.extracted.time || '', phantom_screener: ev.extracted.phantom_screener || '', mcl_representant: ev.extracted.mcl_representant || '', uld: ev.extracted.uld || '', pieces: evPieces }
              }
              lines[lineIdx] = line
            }
          }
        }

        if (isSimpleBooking) {
          const bkPieces = bData.pieces || 0
          let status = 'pending'
          if (bookingLevelPieces > bkPieces) status = 'error'
          else if (bookingLevelPieces === bkPieces && bookingLevelPieces > 0) status = 'complete'
          else if (bookingLevelPieces > 0) status = 'partial'
          const update = { screening_events: keptEventIds, screening_status: status, screening_pieces_total: bookingLevelPieces }
          if (simpleBookingCert) update.doc_screening_cert = simpleBookingCert
          if (simpleBookingDetails) update.screening_details = simpleBookingDetails
          await bDoc.ref.update(update)
        } else if (isMawbBooking) {
          const bkPieces = lines.length > 0 ? lines.reduce((s, l) => s + (l.pieces || 0), 0) : (bData.pieces || 0)
          let status = 'pending'
          if (bookingLevelPieces > bkPieces) status = 'error'
          else if (bookingLevelPieces === bkPieces && bookingLevelPieces > 0) status = 'complete'
          else if (bookingLevelPieces > 0) status = 'partial'
          await bDoc.ref.update({ screening_events: keptEventIds, screening_status: status, screening_pieces_total: bookingLevelPieces, awb_lines: lines })
        } else {
          lines = lines.map(line => {
            const screened = line.screening_pieces_screened || 0
            const total = line.pieces || 0
            if (screened <= 0) return line
            let st = 'pending'
            if (screened > total) st = 'error'
            else if (screened === total) st = 'complete'
            else st = 'partial'
            return { ...line, screening_status: st }
          })
          const totals = calcBookingScreeningTotals(lines)
          await bDoc.ref.update({ screening_events: keptEventIds, screening_status: totals.status, screening_pieces_total: totals.totalScreened, awb_lines: lines })
        }
      }

      bookingsCleaned++
    }
  } else {
    // No date filter — clean all bookings with screening data
    const bookingsSnap = await db.collection('airfreight_bookings')
      .where('screening_status', 'in', ['pending', 'partial', 'complete', 'error'])
      .get()

    for (const bDoc of bookingsSnap.docs) {
      const data = bDoc.data()
      const update = {
        screening_status: admin.firestore.FieldValue.delete(),
        screening_pieces_total: admin.firestore.FieldValue.delete(),
        screening_events: admin.firestore.FieldValue.delete(),
      }
      if (data.awb_lines) {
        update.awb_lines = data.awb_lines.map(line => {
          const { screening_status, screening_pieces_screened, doc_screening_cert, screening_details, ...rest } = line
          return rest
        })
      }
      await bDoc.ref.update(update)
    }
    bookingsCleaned = bookingsSnap.size
  }

  // 3. Reset or set last_run
  if (fromDate) {
    // Set last_run to the fromDate so next run re-processes from there
    await db.doc('screening_settings/config').update({
      last_run: new Date(fromDate + 'T00:00:00Z').toISOString(),
      last_run_status: 'reset',
      last_run_count: admin.firestore.FieldValue.delete(),
    })
  } else {
    await db.doc('screening_settings/config').update({
      last_run: admin.firestore.FieldValue.delete(),
      last_run_status: admin.firestore.FieldValue.delete(),
      last_run_count: admin.firestore.FieldValue.delete(),
    })
  }

  console.log(`Reset screening data${fromDate ? ' from ' + fromDate : ' (all)'}: ${eventsSnap.size} events deleted, ${bookingsCleaned} bookings cleaned`)
  return { eventsDeleted: eventsSnap.size, bookingsCleaned, fromDate: fromDate || 'all' }
})

// ── processScreeningEmails (v2 scheduled, 3x/day) ────────────────────────

exports.processScreeningEmails = onSchedule({
  schedule: '0 8,13,18,21,23 * * *', // 8am, 1pm, 6pm, 9pm, 11pm
  timeZone: 'America/Los_Angeles',
  secrets: [GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER, GMAIL_APP_PASSWORD],
  timeoutSeconds: 540,
  memory: '512MiB',
}, async () => {
  await runScreeningProcessor()
})

// Manual trigger via callable (for "Run Now" button) — no public access needed
exports.triggerScreeningManual = onCall({
  secrets: [GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER, GMAIL_APP_PASSWORD],
  timeoutSeconds: 540,
  memory: '512MiB',
}, async (request) => {
  // onCall automatically verifies Firebase Auth
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be logged in')
  }
  const email = request.auth.token.email || ''
  if (!email.endsWith('@mincurllogistics.com')) {
    throw new HttpsError('permission-denied', 'MCL only')
  }

  try {
    const result = await runScreeningProcessor()
    return result
  } catch (err) {
    console.error('Manual screening trigger error:', err)
    throw new HttpsError('internal', err.message)
  }
})

async function runScreeningProcessor() {
  console.log('=== Screening Agent: starting ===')

  // 1. Read settings
  const settingsDoc = await db.doc('screening_settings/config').get()
  const settings = settingsDoc.exists ? settingsDoc.data() : { enabled: false, phantom_k9_emails: [], mcl_alert_emails: [] }

  if (!settings.enabled) {
    console.log('Screening agent disabled, skipping')
    return { status: 'disabled', count: 0 }
  }

  // 2. Gmail: search for new Phantom K9 emails
  const gmail = getGmailClient()
  let gmailAccount = 'unknown'
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' })
    gmailAccount = profile.data.emailAddress || 'unknown'
    console.log(`Gmail account: ${gmailAccount} | messagesTotal: ${profile.data.messagesTotal}`)
    await db.doc('screening_settings/config').update({
      gmail_account: gmailAccount,
      gmail_messages_total: profile.data.messagesTotal || 0,
    })
  } catch (e) { console.warn('Could not get Gmail profile:', e.message) }
  const lastRun = settings.last_run || '2020-01-01T00:00:00Z'
  const afterEpoch = Math.floor(new Date(lastRun).getTime() / 1000)

  const searchQuery = `subject:"screening result" has:attachment after:${afterEpoch}`
  console.log('Gmail search query:', searchQuery, '| lastRun:', lastRun)
  let messageIds = []
  try {
    // Paginate through all pages and include Spam/Trash to avoid missing emails
    let pageToken = undefined
    let pageCount = 0
    do {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: searchQuery,
        maxResults: 100,
        includeSpamTrash: true,
        pageToken,
      })
      const pageIds = (listRes.data.messages || []).map(m => m.id)
      messageIds.push(...pageIds)
      pageToken = listRes.data.nextPageToken
      pageCount++
      console.log(`  page ${pageCount}: +${pageIds.length} ids (resultSizeEstimate: ${listRes.data.resultSizeEstimate})`)
    } while (pageToken && pageCount < 10)
  } catch (err) {
    console.error('Gmail search error:', err)
    // Do NOT update last_run on Gmail error — keep old value to retry next time
    await db.doc('screening_settings/config').update({
      last_run_status: 'error',
      last_run_count: 0,
    })
    return { status: 'error', error: err.message }
  }

  console.log(`Found ${messageIds.length} potential screening emails`)
  await db.doc('screening_settings/config').update({
    last_search_found: messageIds.length,
  })
  let processed = 0
  const perMessageDiag = []
  // In-memory dedup: track AWB+ULD combos processed in this run to avoid double-counting
  const processedUldKeys = new Set()

  // ── Retry unmatched events: re-run matching with current booking data ──
  // This handles cases where bookings were created/updated after the original processing
  // (e.g., simple bookings that weren't matched before step 1b was added)
  const unmatchedSnap = await db.collection('screening_events')
    .where('status', 'in', ['unmatched', 'error'])
    .get()
  let retried = 0
  for (const evDoc of unmatchedSnap.docs) {
    const ev = evDoc.data()
    const evExtracted = ev.extracted || {}
    const evAwb = (evExtracted.awb || '').trim()
    if (!evAwb) continue // no AWB data to retry
    if (ev.error_reason === 'No AWB lines found in email body') continue // extraction failure, not a matching issue

    try {
      const match = await findMatchingBooking(evExtracted)
      if (!match || match.matchMethod === 'unmatched') continue // still no match

      console.log(`Retry unmatched: event ${evDoc.id} AWB ${evAwb} → NOW matches booking ${match.bookingId} via ${match.matchMethod}`)

      // Re-read fresh booking
      const freshBookingSnap = await db.doc(`airfreight_bookings/${match.bookingId}`).get()
      const freshBooking = freshBookingSnap.data()
      const bookingRef = db.doc(`airfreight_bookings/${match.bookingId}`)

      const certDoc = {
        url: ev.pdf_url || '',
        filename: ev.pdf_filename || '',
        uploaded_at: ev.processed_at || new Date().toISOString(),
        uploaded_by: 'screening-agent',
        modified_seen: false,
      }
      const group = {
        awb: evAwb,
        pieces: evExtracted.pieces || 0,
        uld_lines: evExtracted.uld_lines || [],
      }
      const screeningDetail = {
        mawb: freshBooking.mawb_number || evAwb,
        awb: evAwb,
        date: evExtracted.date || '',
        time: evExtracted.time || '',
        phantom_screener: evExtracted.phantom_screener || '',
        mcl_representant: evExtracted.mcl_representant || '',
        uld: (evExtracted.uld_lines || []).map(l => `${l.uld_type} ${l.uld_number}`).join(', '),
        pieces: group.pieces,
      }

      // ULD dedup check
      const groupAwbNorm = normalizeAwb(evAwb)
      const alreadyProcessedUlds = new Set()
      const existingEvents = await db.collection('screening_events')
        .where('matched_booking_id', '==', match.bookingId)
        .get()
      for (const d of existingEvents.docs) {
        if (d.id === evDoc.id) continue // skip self to avoid marking own ULDs as duplicates
        const e2 = d.data()
        if (e2.status === 'duplicate') continue
        if (normalizeAwb(e2.extracted?.awb || '') !== groupAwbNorm) continue
        for (const l of (e2.extracted?.uld_lines || [])) {
          const u = normalizeAwb(l.uld_number || '')
          if (u) alreadyProcessedUlds.add(u)
        }
      }
      const newUldLines = group.uld_lines.filter(l => {
        const u = normalizeAwb(l.uld_number || '')
        return u && !alreadyProcessedUlds.has(u)
      })
      if (newUldLines.length === 0 && group.uld_lines.length > 0) {
        // All ULDs duplicate — mark event as duplicate, don't update booking
        await evDoc.ref.update({
          status: 'duplicate',
          match_status: 'duplicate',
          matched_booking_id: match.bookingId,
          matched_flight_id: match.flightId || null,
          match_method: match.matchMethod,
          retried_at: new Date().toISOString(),
        })
        console.log(`Retry unmatched: event ${evDoc.id} AWB ${evAwb} — all ULDs duplicate, marked as duplicate`)
        retried++
        continue
      }

      // Recalculate pieces from non-duplicate ULDs
      const dedupedPieces = newUldLines.length > 0
        ? newUldLines.reduce((s, l) => s + (parseInt(l.pieces) || 0), 0)
        : group.pieces
      group.pieces = dedupedPieces

      // Calculate prev screened from existing events
      let prevFromEvents = 0
      for (const d of existingEvents.docs) {
        const e2 = d.data()
        if (e2.status === 'duplicate') continue
        if (d.id === evDoc.id) continue // don't count self
        prevFromEvents += e2.extracted?.pieces || 0
      }

      let lines = freshBooking.awb_lines ? [...freshBooking.awb_lines] : []
      let lineStatus = 'pending'
      let bookingStatus, bookingScreenedTotal, isError, errorReason

      if (match.awbLineIndex === -2) {
        // Simple booking match
        const newTotal = prevFromEvents + group.pieces
        const bkPieces = freshBooking.pieces || 0
        let simpleStatus = 'pending'
        if (newTotal > bkPieces) simpleStatus = 'error'
        else if (newTotal === bkPieces && newTotal > 0) simpleStatus = 'complete'
        else if (newTotal > 0) simpleStatus = 'partial'

        bookingStatus = simpleStatus
        bookingScreenedTotal = newTotal
        isError = simpleStatus === 'error'
        errorReason = isError ? 'Screened pieces exceed booking pieces' : null

        // Update event
        await evDoc.ref.update({
          status: isError ? 'error' : 'processed',
          match_status: isError ? 'error' : 'matched',
          matched_booking_id: match.bookingId,
          matched_flight_id: match.flightId || null,
          match_method: match.matchMethod,
          matched_via: match.matchedVia || null,
          matched_line_awb: match.matchedLineAwb || null,
          error_reason: errorReason,
          retried_at: new Date().toISOString(),
        })

        // Update booking
        await bookingRef.update({
          screening_status: bookingStatus,
          screening_pieces_total: bookingScreenedTotal,
          screening_events: admin.firestore.FieldValue.arrayUnion(evDoc.id),
          doc_screening_cert: {
            ...certDoc,
            version: (freshBooking.doc_screening_cert?.version || 0) + 1,
            history: freshBooking.doc_screening_cert
              ? [...(freshBooking.doc_screening_cert.history || []), {
                  url: freshBooking.doc_screening_cert.url,
                  filename: freshBooking.doc_screening_cert.filename,
                  version: freshBooking.doc_screening_cert.version,
                  uploaded_at: freshBooking.doc_screening_cert.uploaded_at,
                  uploaded_by: freshBooking.doc_screening_cert.uploaded_by,
                }]
              : [],
          },
          screening_details: screeningDetail,
        })

        console.log(`Retry unmatched: event ${evDoc.id} AWB ${evAwb} → SIMPLE booking ${match.bookingId}, ${bookingScreenedTotal}/${bkPieces} pcs → ${bookingStatus}`)

      } else if (match.matchMethod === 'mawb' && match.awbLineIndex < 0) {
        // MAWB match
        const newTotal = prevFromEvents + group.pieces
        const bkPieces = lines.length > 0
          ? lines.reduce((s, l) => s + (l.pieces || 0), 0)
          : (freshBooking.pieces || 0)
        let mawbStatus = 'pending'
        if (newTotal > bkPieces) mawbStatus = 'error'
        else if (newTotal === bkPieces && newTotal > 0) mawbStatus = 'complete'
        else if (newTotal > 0) mawbStatus = 'partial'

        bookingStatus = mawbStatus
        bookingScreenedTotal = newTotal
        isError = mawbStatus === 'error'
        errorReason = isError ? 'Screened pieces exceed booking pieces' : null

        await evDoc.ref.update({
          status: isError ? 'error' : 'processed',
          match_status: isError ? 'error' : 'matched',
          matched_booking_id: match.bookingId,
          matched_flight_id: match.flightId || null,
          match_method: match.matchMethod,
          matched_via: match.matchedVia || null,
          matched_line_awb: match.matchedLineAwb || null,
          error_reason: errorReason,
          retried_at: new Date().toISOString(),
        })

        const bookingUpdate = {
          screening_status: bookingStatus,
          screening_pieces_total: bookingScreenedTotal,
          screening_events: admin.firestore.FieldValue.arrayUnion(evDoc.id),
        }
        if (lines.length > 0) bookingUpdate.awb_lines = lines
        await bookingRef.update(bookingUpdate)

        console.log(`Retry unmatched: event ${evDoc.id} AWB ${evAwb} → MAWB booking ${match.bookingId}, ${bookingScreenedTotal}/${bkPieces} pcs → ${bookingStatus}`)

      } else if (match.awbLineIndex >= 0 && lines.length > match.awbLineIndex) {
        // Line match
        const line = { ...lines[match.awbLineIndex] }
        const matchedLineAwb = match.matchedLineAwb || ''
        let prevLineFromEvents = 0
        for (const d of existingEvents.docs) {
          const e2 = d.data()
          if (e2.status === 'duplicate') continue
          if (d.id === evDoc.id) continue
          if (e2.matched_line_awb === matchedLineAwb) prevLineFromEvents += e2.extracted?.pieces || 0
        }
        const newScreened = prevLineFromEvents + group.pieces
        const linePieces = line.pieces || 0
        if (newScreened > linePieces) lineStatus = 'error'
        else if (newScreened === linePieces) lineStatus = 'complete'
        else if (newScreened > 0) lineStatus = 'partial'

        line.screening_status = lineStatus
        line.screening_pieces_screened = newScreened
        line.doc_screening_cert = {
          ...certDoc,
          version: (line.doc_screening_cert?.version || 0) + 1,
          history: line.doc_screening_cert
            ? [...(line.doc_screening_cert.history || []), {
                url: line.doc_screening_cert.url, filename: line.doc_screening_cert.filename,
                version: line.doc_screening_cert.version, uploaded_at: line.doc_screening_cert.uploaded_at,
                uploaded_by: line.doc_screening_cert.uploaded_by,
              }]
            : [],
        }
        line.screening_details = screeningDetail
        lines[match.awbLineIndex] = line

        const totals = calcBookingScreeningTotals(lines)
        bookingStatus = totals.status
        bookingScreenedTotal = totals.totalScreened
        isError = totals.status === 'error' || lineStatus === 'error'
        errorReason = isError ? 'Screened pieces exceed booking pieces' : null

        await evDoc.ref.update({
          status: isError ? 'error' : 'processed',
          match_status: isError ? 'error' : 'matched',
          matched_booking_id: match.bookingId,
          matched_flight_id: match.flightId || null,
          match_method: match.matchMethod,
          matched_via: match.matchedVia || null,
          matched_line_awb: matchedLineAwb,
          error_reason: errorReason,
          retried_at: new Date().toISOString(),
        })

        const bookingUpdate = {
          screening_status: bookingStatus,
          screening_pieces_total: bookingScreenedTotal,
          screening_events: admin.firestore.FieldValue.arrayUnion(evDoc.id),
          awb_lines: lines,
        }
        await bookingRef.update(bookingUpdate)

        console.log(`Retry unmatched: event ${evDoc.id} AWB ${evAwb} → line[${match.awbLineIndex}] booking ${match.bookingId}, ${bookingScreenedTotal} pcs → ${bookingStatus}`)
      }

      retried++
    } catch (err) {
      console.error(`Retry unmatched: error retrying event ${evDoc.id}:`, err.message)
    }
  }
  console.log(`Retry unmatched: ${retried}/${unmatchedSnap.size} events retried successfully`)

  for (const msgId of messageIds) {
    const diag = { msgId, outcome: 'unknown' }
    perMessageDiag.push(diag)
    try {
      // Check if already processed
      const existing = await db.collection('screening_events')
        .where('gmail_message_id', '==', msgId)
        .get()
      if (!existing.empty) {
        // Ignore extraction-failure error events — they mean parsing failed and should be retried
        const extractionErrors = existing.docs.filter(d => {
          const data = d.data()
          return data.status === 'error' && data.error_reason === 'No AWB lines found in email body'
        })
        const realEvents = existing.docs.filter(d => {
          const data = d.data()
          return !(data.status === 'error' && data.error_reason === 'No AWB lines found in email body')
        })
        if (extractionErrors.length > 0 && realEvents.length === 0) {
          // Only extraction errors exist — delete them and retry
          const delBatch = db.batch()
          extractionErrors.forEach(d => delBatch.delete(d.ref))
          await delBatch.commit()
          console.log(`Message ${msgId}: deleted ${extractionErrors.length} extraction-failure events, retrying`)
        } else {
          diag.outcome = 'already_processed'
          console.log(`Message ${msgId} already processed (${existing.size} events), skipping`)
          continue
        }
      }

      // Get full message
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: msgId,
        format: 'full',
      })

      const headers = msg.data.payload.headers || []
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || ''
      const dateStr = headers.find(h => h.name.toLowerCase() === 'date')?.value || ''
      diag.subject = subject.slice(0, 80)

      // Extract email body text for AWB parsing
      const bodyText = getEmailBodyText(msg.data.payload)
      diag.bodyLen = bodyText.length
      diag.topMime = msg.data.payload.mimeType

      // Find PDF attachments — recursively walk MIME tree
      // (Fwd: emails nest attachments deeper than top-level parts)
      const pdfParts = []
      function collectPdfParts(node) {
        if (!node) return
        if (node.filename && node.filename.toLowerCase().endsWith('.pdf')) {
          const fname = node.filename.toLowerCase()
          if (!fname.includes('acceptance') && node.body?.attachmentId) {
            pdfParts.push(node)
          }
        }
        for (const child of (node.parts || [])) collectPdfParts(child)
      }
      collectPdfParts(msg.data.payload)
      diag.pdfPartsFound = pdfParts.length

      let screeningPdf = null
      if (pdfParts.length > 0) {
        // Prioritize PDF whose filename contains "screen" (the actual certificate)
        // over AWB/waybill PDFs that may also be attached
        const screenPart = pdfParts.find(p => {
          const fn = p.filename.toLowerCase()
          return fn.includes('screen') || fn.includes('certificate') || fn.includes('cert')
        })
        const part = screenPart || pdfParts[0]
        const attachRes = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: msgId,
          id: part.body.attachmentId,
        })
        screeningPdf = {
          filename: part.filename,
          data: attachRes.data.data, // base64url encoded
        }
      }

      if (!screeningPdf) {
        diag.outcome = 'no_pdf'
        console.log(`Message ${msgId}: no screening PDF attachment found, skipping`)
        continue
      }

      // Convert base64url to standard base64
      const pdfBase64 = screeningPdf.data.replace(/-/g, '+').replace(/_/g, '/')

      // Upload PDF to Storage with download token
      const now = new Date()
      const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      const storagePath = `airfreight/screening-certs/${yearMonth}/${msgId}_${screeningPdf.filename}`
      const file = bucket.file(storagePath)
      const downloadToken = require('crypto').randomUUID()
      await file.save(Buffer.from(pdfBase64, 'base64'), {
        contentType: 'application/pdf',
        metadata: {
          contentType: 'application/pdf',
          metadata: { firebaseStorageDownloadTokens: downloadToken },
        },
      })
      const pdfUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${downloadToken}`

      // Parse screening data from email body (no AI needed)
      const extracted = parseEmailBody(bodyText)
      diag.parsedLines = extracted.uld_lines.length
      if (extracted.uld_lines.length === 0) {
        // Log body sample for debugging regex mismatches
        const sample = bodyText.slice(0, 1500).replace(/\n/g, '\\n')
        console.log(`Message ${msgId}: BODY SAMPLE (0 lines): ${sample}`)
      }
      console.log(`Message ${msgId}: parsed ${extracted.uld_lines.length} AWB lines from email body`)

      // Group ULD lines by AWB — one certificate can contain multiple AWBs
      const awbGroups = groupByAwb(extracted)
      diag.groups = awbGroups.length

      if (awbGroups.length === 0) {
        diag.outcome = 'no_awb_lines'
        await db.collection('screening_events').add({
          gmail_message_id: msgId,
          gmail_subject: subject,
          gmail_date: dateStr,
          pdf_url: pdfUrl,
          pdf_storage_path: storagePath,
          pdf_filename: screeningPdf.filename,
          extracted: { ...extracted, mawb: '', awb: '', pieces: 0 },
          matched_booking_id: null,
          matched_flight_id: null,
          match_method: 'unmatched',
          match_status: 'error',
          error_reason: 'No AWB lines found in email body',
          processed_at: now.toISOString(),
          status: 'error',
        })
        console.log(`Message ${msgId}: no AWB lines extracted`)
        continue
      }

      console.log(`Message ${msgId}: found ${awbGroups.length} AWB groups: ${awbGroups.map(g => g.awb + '(' + g.pieces + 'pcs)').join(', ')}`)

      // Process each AWB group as a separate screening event
      for (const group of awbGroups) {
        const groupExtracted = {
          mawb: '',
          awb: group.awb,
          date: extracted.date || '',
          time: extracted.time || '',
          phantom_screener: extracted.phantom_screener || '',
          mcl_representant: extracted.mcl_representant || '',
          uld: group.uld_lines.map(l => `${l.uld_type} ${l.uld_number}`).join(', '),
          pieces: group.pieces,
          uld_lines: group.uld_lines,
        }

        // AWB Matching
        const match = await findMatchingBooking(groupExtracted)

        if (!match || match.matchMethod === 'unmatched') {
          const nearSuggestion = match?.nearMatchSuggestion || null
          await db.collection('screening_events').add({
            gmail_message_id: msgId,
            gmail_subject: subject,
            gmail_date: dateStr,
            pdf_url: pdfUrl,
            pdf_filename: screeningPdf.filename,
            extracted: groupExtracted,
            matched_booking_id: null,
            matched_flight_id: null,
            match_method: 'unmatched',
            match_status: 'unmatched',
            near_match_suggestion: nearSuggestion,
            processed_at: now.toISOString(),
            status: 'unmatched',
          })
          console.log(`Message ${msgId}: AWB ${group.awb} (${group.pieces} pcs) — no matching booking found${nearSuggestion ? ` | NEAR MATCH: ${nearSuggestion}` : ''}`)
          continue
        }

        // Dedup per-ULD: remove ULDs already screened for this booking+AWB
        // (same physical pallet appearing in a different cert/email).
        // Only the NEW ULDs count toward screened pieces.
        const groupAwbNorm = normalizeAwb(group.awb)

        // Collect all ULDs already processed: from DB + from this run (in-memory)
        const alreadyProcessedUlds = new Set()

        // In-memory: ULDs processed in this same run
        for (const key of processedUldKeys) {
          const [bId, awbN, uld] = key.split('::')
          if (bId === match.bookingId && awbN === groupAwbNorm) alreadyProcessedUlds.add(uld)
        }

        // DB: ULDs from existing screening_events for this booking
        const existingEvents = await db.collection('screening_events')
          .where('matched_booking_id', '==', match.bookingId)
          .get()
        for (const d of existingEvents.docs) {
          const ev = d.data()
          if (ev.status === 'duplicate') continue
          if (normalizeAwb(ev.extracted?.awb || '') !== groupAwbNorm) continue
          for (const l of (ev.extracted?.uld_lines || [])) {
            const u = normalizeAwb(l.uld_number || '')
            if (u) alreadyProcessedUlds.add(u)
          }
        }

        // Filter out duplicate ULDs, keep only new ones
        const newUldLines = group.uld_lines.filter(l => {
          const u = normalizeAwb(l.uld_number || '')
          return u && !alreadyProcessedUlds.has(u)
        })
        const dupUldLines = group.uld_lines.filter(l => {
          const u = normalizeAwb(l.uld_number || '')
          return u && alreadyProcessedUlds.has(u)
        })

        if (dupUldLines.length > 0) {
          const dupNames = dupUldLines.map(l => `${l.uld_type} ${l.uld_number} (${l.pieces}pcs)`).join(', ')
          console.log(`Message ${msgId}: AWB ${group.awb} — skipping duplicate ULD(s): ${dupNames}`)
        }

        // If ALL ULDs are duplicates, skip entirely
        if (newUldLines.length === 0) {
          console.log(`Message ${msgId}: AWB ${group.awb} — ALL ULDs duplicate, skipping booking update`)
          await db.collection('screening_events').add({
            gmail_message_id: msgId, gmail_subject: subject, gmail_date: dateStr,
            pdf_url: pdfUrl, pdf_filename: screeningPdf.filename, extracted: groupExtracted,
            matched_booking_id: match.bookingId, matched_flight_id: match.flightId || null,
            match_method: match.matchMethod, match_status: 'duplicate',
            processed_at: now.toISOString(), status: 'duplicate',
          })
          continue
        }

        // Recalculate pieces using only new (non-duplicate) ULDs
        const dedupedPieces = newUldLines.reduce((s, l) => s + (parseInt(l.pieces) || 0), 0)
        group.pieces = dedupedPieces
        group.uld_lines = newUldLines
        // Update groupExtracted with deduped values
        groupExtracted.pieces = dedupedPieces
        groupExtracted.uld = newUldLines.map(l => `${l.uld_type} ${l.uld_number}`).join(', ')
        groupExtracted.uld_lines = newUldLines

        // Mark each new ULD as processed for in-memory dedup
        for (const l of newUldLines) {
          const u = normalizeAwb(l.uld_number || '')
          if (u) processedUldKeys.add(`${match.bookingId}::${groupAwbNorm}::${u}`)
        }

        // Re-read booking to get latest values (another group from same cert may have updated it)
        const freshBookingSnap = await db.doc(`airfreight_bookings/${match.bookingId}`).get()
        const freshBooking = freshBookingSnap.data()
        const bookingRef = db.doc(`airfreight_bookings/${match.bookingId}`)

        // Build cert document and screening details (shared by both paths)
        const certDoc = {
          url: pdfUrl,
          filename: screeningPdf.filename,
          uploaded_at: now.toISOString(),
          uploaded_by: 'screening-agent',
          modified_seen: false,
        }
        const screeningDetail = {
          mawb: freshBooking.mawb_number || group.awb,
          awb: group.awb,
          date: extracted.date,
          time: extracted.time,
          phantom_screener: extracted.phantom_screener,
          mcl_representant: extracted.mcl_representant,
          uld: group.uld_lines.map(l => `${l.uld_type} ${l.uld_number}`).join(', '),
          pieces: group.pieces,
        }

        let lines = freshBooking.awb_lines ? [...freshBooking.awb_lines] : []
        let lineStatus = 'pending'

        // Recalculate total screened from existing screening_events (source of truth)
        // instead of reading from booking fields which may be stale/residual
        const existingEventsForCalc = await db.collection('screening_events')
          .where('matched_booking_id', '==', match.bookingId)
          .get()
        let prevFromEvents = 0
        for (const d of existingEventsForCalc.docs) {
          const ev = d.data()
          if (ev.status === 'duplicate') continue
          prevFromEvents += ev.extracted?.pieces || 0
        }

        if (match.matchMethod === 'mawb' && match.awbLineIndex < 0) {
          // MAWB match (ecommerce/Merflex): cert covers the whole MAWB
          // Sum pieces from existing events + current group
          const newTotal = prevFromEvents + group.pieces
          const bkPieces = lines.length > 0
            ? lines.reduce((s, l) => s + (l.pieces || 0), 0)
            : (freshBooking.pieces || 0)

          let mawbStatus = 'pending'
          if (newTotal > bkPieces) mawbStatus = 'error'
          else if (newTotal === bkPieces && newTotal > 0) mawbStatus = 'complete'
          else if (newTotal > 0) mawbStatus = 'partial'

          // Will be written in bookingUpdate below (overrides calcBookingScreeningTotals)
          match._mawbOverride = { screening_pieces_total: newTotal, screening_status: mawbStatus }
          lineStatus = mawbStatus

          // MAWB screening data stays at booking level only (not distributed
          // to child AWB lines). The UI reads booking.screening_status and
          // booking.screening_pieces_total for MAWB bookings.

          console.log(`Message ${msgId}: AWB ${group.awb} → MAWB match, ${newTotal}/${bkPieces} pcs → ${mawbStatus}`)

        } else if (match.awbLineIndex === -2) {
          // Simple booking match: no awb_lines, screening data at booking level
          const newTotal = prevFromEvents + group.pieces
          const bkPieces = freshBooking.pieces || 0

          let simpleStatus = 'pending'
          if (newTotal > bkPieces) simpleStatus = 'error'
          else if (newTotal === bkPieces && newTotal > 0) simpleStatus = 'complete'
          else if (newTotal > 0) simpleStatus = 'partial'

          match._simpleOverride = {
            screening_pieces_total: newTotal,
            screening_status: simpleStatus,
            doc_screening_cert: {
              ...certDoc,
              version: (freshBooking.doc_screening_cert?.version || 0) + 1,
              history: freshBooking.doc_screening_cert
                ? [...(freshBooking.doc_screening_cert.history || []), {
                    url: freshBooking.doc_screening_cert.url,
                    filename: freshBooking.doc_screening_cert.filename,
                    version: freshBooking.doc_screening_cert.version,
                    uploaded_at: freshBooking.doc_screening_cert.uploaded_at,
                    uploaded_by: freshBooking.doc_screening_cert.uploaded_by,
                  }]
                : [],
            },
            screening_details: screeningDetail,
          }
          lineStatus = simpleStatus

          console.log(`Message ${msgId}: AWB ${group.awb} → SIMPLE booking match, ${newTotal}/${bkPieces} pcs → ${simpleStatus}`)

        } else if (match.awbLineIndex >= 0 && lines.length > match.awbLineIndex) {
          // Direct AWB line match: update only the specific line
          const line = { ...lines[match.awbLineIndex] }
          // Recalculate from events targeting this specific AWB line
          const matchedLineAwb = match.matchedLineAwb || ''
          let prevLineFromEvents = 0
          for (const d of existingEventsForCalc.docs) {
            const ev = d.data()
            if (ev.status === 'duplicate') continue
            if (ev.matched_line_awb === matchedLineAwb) prevLineFromEvents += ev.extracted?.pieces || 0
          }
          const newScreened = prevLineFromEvents + group.pieces
          const linePieces = line.pieces || 0

          if (newScreened > linePieces) lineStatus = 'error'
          else if (newScreened === linePieces) lineStatus = 'complete'
          else if (newScreened > 0) lineStatus = 'partial'

          line.screening_status = lineStatus
          line.screening_pieces_screened = newScreened
          line.doc_screening_cert = {
            ...certDoc,
            version: (line.doc_screening_cert?.version || 0) + 1,
            history: line.doc_screening_cert
              ? [...(line.doc_screening_cert.history || []), {
                  url: line.doc_screening_cert.url,
                  filename: line.doc_screening_cert.filename,
                  version: line.doc_screening_cert.version,
                  uploaded_at: line.doc_screening_cert.uploaded_at,
                  uploaded_by: line.doc_screening_cert.uploaded_by,
                }]
              : [],
          }
          line.screening_details = screeningDetail
          lines[match.awbLineIndex] = line
        }

        // Calculate totals
        let bookingStatus, bookingScreenedTotal, isError, errorReason

        if (match._simpleOverride) {
          // Simple booking match: use booking-level totals
          bookingStatus = match._simpleOverride.screening_status
          bookingScreenedTotal = match._simpleOverride.screening_pieces_total
          isError = bookingStatus === 'error'
          errorReason = isError ? 'Screened pieces exceed booking pieces' : null
        } else if (match._mawbOverride) {
          // MAWB match: use booking-level totals
          bookingStatus = match._mawbOverride.screening_status
          bookingScreenedTotal = match._mawbOverride.screening_pieces_total
          isError = bookingStatus === 'error'
          errorReason = isError ? 'Screened pieces exceed booking pieces' : null
        } else {
          // Line match: recalculate from lines
          const totals = calcBookingScreeningTotals(lines)
          bookingStatus = totals.status
          bookingScreenedTotal = totals.totalScreened
          isError = totals.status === 'error' || lineStatus === 'error'
          errorReason = isError ? 'Screened pieces exceed booking pieces' : null
        }

        // Save screening event (one per AWB group)
        const eventRef = await db.collection('screening_events').add({
          gmail_message_id: msgId,
          gmail_subject: subject,
          gmail_date: dateStr,
          pdf_url: pdfUrl,
          pdf_storage_path: storagePath,
          pdf_filename: screeningPdf.filename,
          extracted: groupExtracted,
          matched_booking_id: match.bookingId,
          matched_flight_id: match.flightId,
          match_method: match.matchMethod,
          matched_via: match.matchedVia || null,
          matched_line_awb: match.matchedLineAwb || null,
          match_status: isError ? 'error' : 'matched',
          error_reason: errorReason,
          processed_at: now.toISOString(),
          status: isError ? 'error' : 'processed',
        })

        // Write booking update
        const bookingUpdate = {
          screening_status: bookingStatus,
          screening_pieces_total: bookingScreenedTotal,
          screening_events: admin.firestore.FieldValue.arrayUnion(eventRef.id),
        }
        if (match._simpleOverride) {
          bookingUpdate.doc_screening_cert = match._simpleOverride.doc_screening_cert
          bookingUpdate.screening_details = match._simpleOverride.screening_details
        }
        if (lines.length > 0) bookingUpdate.awb_lines = lines

        await bookingRef.update(bookingUpdate)

        if (isError) {
          try {
            await sendErrorAlert(settings, { extracted: groupExtracted, pdf_filename: screeningPdf.filename }, errorReason)
          } catch (err) {
            console.error('Error sending alert email:', err)
          }
        }

        console.log(`Message ${msgId}: AWB ${group.awb} → ${bookingStatus} (${bookingScreenedTotal} pcs) → booking ${match.bookingId} [line ${match.awbLineIndex}]`)
      }

      processed++
      diag.outcome = 'processed'

      // Mark email as read
      try {
        await gmail.users.messages.modify({
          userId: 'me',
          id: msgId,
          requestBody: { removeLabelIds: ['UNREAD'] },
        })
      } catch (err) {
        console.warn(`Could not mark message ${msgId} as read:`, err.message)
      }

    } catch (err) {
      diag.outcome = 'exception'
      diag.error = err.message
      console.error(`Error processing message ${msgId}:`, err)
    }
  }

  // Update settings — always update last_run to reflect when the agent last ran
  const updateData = {
    last_run: new Date().toISOString(),
    last_run_status: 'success',
    last_run_count: processed,
    last_run_retried: retried,
    last_run_diag: perMessageDiag,
  }
  await db.doc('screening_settings/config').update(updateData)

  console.log(`=== Screening Agent: done, processed ${processed} emails, retried ${retried} unmatched events ===`)
  return { status: 'success', count: processed, retriedUnmatched: retried }
}

// ── checkScreeningAlerts (v2 scheduled, 1x/day) ──────────────────────────

exports.checkScreeningAlerts = onSchedule({
  schedule: '0 9 * * *', // 9am daily
  timeZone: 'America/Los_Angeles',
  secrets: [GMAIL_USER, GMAIL_APP_PASSWORD],
  timeoutSeconds: 120,
  memory: '512MiB',
}, async () => {
  console.log('=== Screening Alerts: starting ===')

  const settingsDoc = await db.doc('screening_settings/config').get()
  const settings = settingsDoc.exists ? settingsDoc.data() : { enabled: false, phantom_k9_emails: [], mcl_alert_emails: [] }

  if (!settings.enabled) {
    console.log('Screening agent disabled, skipping alerts')
    return
  }

  if (!settings.phantom_k9_emails || settings.phantom_k9_emails.length === 0) {
    console.log('No Phantom K9 emails configured, skipping alerts')
    return
  }

  // Find flights closed in the last 7 days
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  const flightsSnap = await db.collection('airfreight_flights')
    .where('status', '==', 'closed')
    .get()

  const recentFlights = flightsSnap.docs.filter(d => {
    const f = d.data()
    return f.flight_datetime >= sevenDaysAgo.toISOString()
  })

  console.log(`Found ${recentFlights.length} recently closed flights to check`)

  const transport = getSmtpTransport()
  const today = new Date().toISOString().split('T')[0]
  let alertsSent = 0

  for (const flightDoc of recentFlights) {
    const flight = flightDoc.data()

    // Find bookings for this flight missing screening
    const bookingsSnap = await db.collection('airfreight_bookings')
      .where('flight_id', '==', flightDoc.id)
      .get()

    for (const bDoc of bookingsSnap.docs) {
      const booking = bDoc.data()
      const screeningStatus = booking.screening_status || 'pending'

      if (screeningStatus === 'complete') continue // all good

      const identifier = booking.mawb_number || booking.awb_2nd_leg || booking.awb_1st_leg || bDoc.id

      // Check existing escalation
      const escSnap = await db.collection('screening_settings').doc('config')
        .collection('escalations')
        .where('booking_id', '==', bDoc.id)
        .where('status', '==', 'open')
        .limit(1)
        .get()

      let escalation = null
      let escRef = null

      if (!escSnap.empty) {
        escRef = escSnap.docs[0].ref
        escalation = escSnap.docs[0].data()
      }

      // Determine if we should send alert today
      let shouldSend = false
      if (!escalation) {
        // First alert
        shouldSend = true
      } else {
        const lastAlert = new Date(escalation.last_alert_date)
        const daysSinceFirst = Math.floor((Date.now() - new Date(escalation.first_alert_date).getTime()) / 86400000)
        const daysSinceLast = Math.floor((Date.now() - lastAlert.getTime()) / 86400000)

        if (daysSinceFirst <= 3) {
          // Days 1-3: daily
          shouldSend = daysSinceLast >= 1
        } else {
          // Day 4+: every 2 days
          shouldSend = daysSinceLast >= 2
        }
      }

      if (!shouldSend) continue

      // Build and send alert email
      const piecesInfo = screeningStatus === 'partial'
        ? `Screened: ${booking.screening_pieces_total || 0} of ${(booking.awb_lines || []).reduce((s, l) => s + (l.pieces || 0), 0)} pieces`
        : 'No screening certificates received'

      const alertNum = escalation ? escalation.alert_count + 1 : 1
      const subject = `[${alertNum > 1 ? 'REMINDER' : 'REQUEST'}] Missing Screening Certificate - ${identifier} - Flight ${flight.flight_number || flight.airline}`

      const html = `
        <h2>Missing Screening Certificate</h2>
        <p><strong>Flight:</strong> ${flight.airline} ${flight.flight_number || ''} — ${flight.flight_datetime}</p>
        <p><strong>Client:</strong> ${booking.client_name}</p>
        <p><strong>MAWB/AWB:</strong> ${identifier}</p>
        <p><strong>Status:</strong> ${screeningStatus.toUpperCase()}</p>
        <p><strong>${piecesInfo}</strong></p>
        ${alertNum > 1 ? `<p>This is reminder #${alertNum}.</p>` : ''}
        <hr>
        <p>Please provide the screening certificate at your earliest convenience.</p>
        <p><em>Automated message from MCL WMS</em></p>
      `

      try {
        await transport.sendMail({
          from: GMAIL_USER.value(),
          to: settings.phantom_k9_emails.join(','),
          cc: (settings.mcl_alert_emails || []).join(','),
          subject,
          html,
        })

        // Update or create escalation entry
        if (escRef) {
          await escRef.update({
            last_alert_date: today,
            alert_count: admin.firestore.FieldValue.increment(1),
          })
        } else {
          await db.collection('screening_settings').doc('config')
            .collection('escalations').add({
              flight_id: flightDoc.id,
              booking_id: bDoc.id,
              mawb_or_awb: identifier,
              first_alert_date: today,
              last_alert_date: today,
              alert_count: 1,
              status: 'open',
            })
        }

        alertsSent++
        console.log(`Alert sent for ${identifier} (alert #${alertNum})`)
      } catch (err) {
        console.error(`Failed to send alert for ${identifier}:`, err)
      }
    }
  }

  console.log(`=== Screening Alerts: done, ${alertsSent} alerts sent ===`)
})

// ── cleanupDriverQueue (scheduled every 30 min) — expire entries >3h ─────

exports.cleanupDriverQueue = onSchedule({
  schedule: 'every 30 minutes',
  timeoutSeconds: 60,
  memory: '256MiB',
}, async () => {
  const now = new Date()
  const snap = await db.collection('driver_queue')
    .where('status', '==', 'waiting')
    .get()

  let expired = 0
  const batch = db.batch()
  for (const doc of snap.docs) {
    const data = doc.data()
    if (data.expires_at && new Date(data.expires_at) < now) {
      batch.update(doc.ref, { status: 'expired' })
      expired++
    }
  }
  if (expired > 0) await batch.commit()
  console.log(`cleanupDriverQueue: expired ${expired} entries`)
})

// ── deleteVendorUser (onCall) — delete vendor user from Auth + Firestore ──

// ── backupFirestore (scheduled daily at 2am PST) — export all collections ───

exports.backupFirestore = onSchedule({
  schedule: '0 2 * * *',
  timeZone: 'America/Los_Angeles',
  timeoutSeconds: 300,
  memory: '512MiB',
}, async () => {
  const client = new admin.firestore.v1.FirestoreAdminClient()
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT
  const databaseName = client.databasePath(projectId, '(default)')

  const timestamp = new Date().toISOString().split('T')[0] // YYYY-MM-DD
  const bucket = `gs://${projectId}-firestore-backups/${timestamp}`

  try {
    const [response] = await client.exportDocuments({
      name: databaseName,
      outputUriPrefix: bucket,
      collectionIds: [], // empty = all collections
    })
    console.log(`backupFirestore: export started -> ${bucket}`)
    console.log(`Operation: ${response.name}`)
  } catch (err) {
    console.error('backupFirestore: FAILED', err.message)
  }
})

exports.deleteVendorUser = onCall({
  timeoutSeconds: 30,
  memory: '256MiB',
}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be logged in')
  const callerEmail = request.auth.token.email || ''
  if (!callerEmail.endsWith('@mincurllogistics.com')) throw new HttpsError('permission-denied', 'MCL only')

  const { uid } = request.data || {}
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required')

  // Delete from Firebase Auth
  try {
    await admin.auth().deleteUser(uid)
  } catch (err) {
    if (err.code !== 'auth/user-not-found') {
      throw new HttpsError('internal', 'Failed to delete auth user: ' + err.message)
    }
  }

  // Delete from user_roles and vendor_users
  try { await db.doc(`user_roles/${uid}`).delete() } catch {}
  try { await db.doc(`vendor_users/${uid}`).delete() } catch {}

  console.log(`Vendor user ${uid} deleted by ${callerEmail}`)
  return { success: true, uid }
})

// ── verifyAwbChw (onRequest) — extract CHW from AWB PDF using Claude Vision ──

exports.verifyAwbChw = onRequest({
  secrets: [ANTHROPIC_API_KEY],
  timeoutSeconds: 60,
  memory: '512MiB',
  cors: true,
}, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return }

  // Verify Firebase Auth token from Authorization header
  const authHeader = req.headers.authorization || ''
  if (!authHeader.startsWith('Bearer ')) { res.status(401).json({ error: 'Unauthorized' }); return }
  const idToken = authHeader.split('Bearer ')[1]
  let decoded
  try {
    decoded = await admin.auth().verifyIdToken(idToken)
  } catch {
    res.status(401).json({ error: 'Invalid token' }); return
  }
  const email = decoded.email || ''
  if (!email.endsWith('@mincurllogistics.com')) { res.status(403).json({ error: 'MCL only' }); return }

  const { pdfUrl, bookingId, awbIndex, weightType } = req.body
  if (!pdfUrl || !bookingId) { res.status(400).json({ error: 'pdfUrl and bookingId required' }); return }
  const wantGross = weightType === 'gross'
  const cacheField = wantGross ? 'verified_gross' : 'verified_chw'

  // Check cache first
  const bookingRef = db.doc(`airfreight_bookings/${bookingId}`)
  const bookingSnap = await bookingRef.get()
  if (!bookingSnap.exists) { res.status(404).json({ error: 'Booking not found' }); return }
  const bookingData = bookingSnap.data()

  // Check if already cached
  if (awbIndex != null && awbIndex >= 0) {
    const line = (bookingData.awb_lines || [])[awbIndex]
    if (line && line[cacheField] != null) {
      res.json({ chw: line[cacheField], cached: true }); return
    }
  } else if (bookingData[cacheField] != null) {
    res.json({ chw: bookingData[cacheField], cached: true }); return
  }

  // Fetch PDF and convert to base64
  let pdfBase64
  try {
    const resp = await fetch(pdfUrl)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const buf = await resp.arrayBuffer()
    pdfBase64 = Buffer.from(buf).toString('base64')
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch PDF: ' + err.message }); return
  }

  // Call Claude Haiku Vision to extract CHW
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() })
  let extractedChw = null
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          },
          {
            type: 'text',
            text: wantGross
              ? 'Extract the Gross Weight from this Air Waybill document. It is labeled "Gross Weight" in the shipment details table. Return ONLY the numeric value in kg, nothing else. If you cannot find it, return "N/A".'
              : 'Extract the Chargeable Weight (CHW) from this Air Waybill document. Return ONLY the numeric value in kg, nothing else. If you cannot find it, return "N/A".',
          },
        ],
      }],
    })
    const text = response.content[0]?.text?.trim() || 'N/A'
    const num = parseFloat(text.replace(/[^0-9.]/g, ''))
    extractedChw = isNaN(num) ? null : num
  } catch (err) {
    console.error('Claude Vision error:', err.message)
    res.status(500).json({ error: 'Vision extraction failed: ' + err.message }); return
  }

  // Cache result in booking
  if (extractedChw != null) {
    try {
      if (awbIndex != null && awbIndex >= 0) {
        const lines = bookingData.awb_lines || []
        if (lines[awbIndex]) {
          lines[awbIndex][cacheField] = extractedChw
          await bookingRef.update({ awb_lines: lines })
        }
      } else {
        await bookingRef.update({ [cacheField]: extractedChw })
      }
    } catch (err) {
      console.warn('Cache write failed:', err.message)
    }
  }

  res.json({ chw: extractedChw, cached: false })
})

// ── avProcessAwbDocs (Firestore trigger) — AI extracts AWB data from PDF ──
// Triggers when av_flight_awbs doc is updated with ai_status='pending'.
// Bypasses Cloud Run IAM issues since Firestore triggers are internal GCP events.

exports.avProcessAwbDocs = onDocumentUpdated({
  document: 'av_flight_awbs/{awbId}',
  secrets: [ANTHROPIC_API_KEY],
  timeoutSeconds: 120,
  memory: '1GiB',
}, async (event) => {
  const before = event.data.before.data()
  const after = event.data.after.data()
  const awbId = event.params.awbId

  // Only trigger when ai_status changes TO 'pending'
  if (after.ai_status !== 'pending' || before.ai_status === 'pending') return

  const docUrl = after.doc_awb_url
  if (!docUrl) {
    await db.doc(`av_flight_awbs/${awbId}`).update({ ai_status: 'failed', ai_error: 'No document URL', updated_at: new Date().toISOString() })
    return
  }

  // Mark as processing
  await db.doc(`av_flight_awbs/${awbId}`).update({ ai_status: 'processing', updated_at: new Date().toISOString() })

  try {
    // Fetch PDF
    const pdfResp = await fetch(docUrl)
    if (!pdfResp.ok) {
      await db.doc(`av_flight_awbs/${awbId}`).update({ ai_status: 'failed', ai_error: `PDF fetch failed: HTTP ${pdfResp.status}` })
      return
    }
    const pdfBuf = await pdfResp.arrayBuffer()
    const pdfBase64 = Buffer.from(pdfBuf).toString('base64')
    console.log(`avProcessAwbDocs: PDF fetched, size=${(pdfBuf.byteLength / 1024 / 1024).toFixed(2)}MB`)

    const awbNumber = after.awb_number || ''
    const flightId = after.flight_id

    // Claude Haiku Vision
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() })
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: `This is a scanned document set that may include an Air Waybill (AWB) along with other documents (7512 customs forms, invoices, packing lists, cargo manifests, etc.).

Your task: Find the MASTER Air Waybill (MAWB) page for AWB number "${awbNumber}" and extract data ONLY from that specific page.

CRITICAL — PAGE IDENTIFICATION:
- The AWB number "${awbNumber}" must appear prominently at the TOP of the page (format: 3 digits dash 8 digits, e.g. 729-95079025)
- A valid AWB page has a standard IATA layout with: Shipper box (top-left), Consignee box (below shipper), Agent box, Airport of Departure, Routing, and a charges table at the bottom
- IGNORE all other pages: 7512 customs forms, commercial invoices, packing lists, cargo manifests, house waybills, and any page where the AWB number does NOT match "${awbNumber}"
- If the PDF contains MULTIPLE Air Waybills, only extract from the one matching "${awbNumber}"

CRITICAL — WEIGHT TABLE (bottom of AWB page):
The charges table at the bottom has these columns IN ORDER from left to right:
  No. of Pieces | Gross Weight | kg/lb | Rate Class | Chargeable Weight | Rate/Charge | Total
- "Gross Weight" is the FIRST weight column (e.g. 2344)
- "Chargeable Weight" is the THIRD weight column, BEFORE Rate/Charge (e.g. 2344)
- "Total" is the LAST numeric column (e.g. 1054.80) — this is the monetary charge, NOT a weight
- DO NOT confuse "Total" (money) with "Chargeable Weight" (kg). Total is usually much smaller and may have decimals like cents
- The "kg/lb" column contains "K" for kilograms or "L" for pounds

Return ONLY a JSON object (no markdown, no explanation):
{
  "iac": "Name of the Issuing Agent or freight forwarder (found near 'Issuing Carrier's Agent' field, NOT the airline name)",
  "pieces": integer (number of pieces from the charges table),
  "gross_weight_kg": number (gross weight from the charges table — if marked K it's already kg, if marked L or LBS divide by 2.205),
  "chw_kg": number (chargeable weight from the charges table — the column BEFORE Rate/Charge, NOT the Total column),
  "dg": boolean (true if Dangerous Goods are indicated anywhere on the AWB),
  "dg_codes": ["UN codes if DG is true, empty array otherwise"],
  "lb": boolean (true if Lithium Batteries are indicated),
  "lb_detail": "lithium battery classification if lb is true, empty string otherwise",
  "shipper_name": "Full name/company of the Shipper (top-left section of AWB)",
  "consignee_name": "Full name/company of the Consignee",
  "agent_name": "Name of the shipper's agent or representative (may be same as shipper)",
  "shipper_phone": "Phone number of the shipper or shipper's representative",
  "nature_of_goods": "Description/nature of goods as stated on the AWB"
}

Rules:
- ONLY extract from the page where AWB number "${awbNumber}" is displayed at the top
- If a numeric field is not found or illegible, use 0
- If a text field is not found or illegible, use empty string ""
- Verify: chargeable weight should be >= gross weight (or close to it). If your chw_kg is much smaller than gross_weight_kg, you likely read the Total (money) column by mistake
- Return {"error": "AWB not found"} ONLY if no AWB page with number "${awbNumber}" exists in the document` },
        ],
      }],
    })

    const rawText = (response.content[0]?.text || '').trim()
    console.log(`avProcessAwbDocs: AI response for ${awbNumber}:`, rawText)

    let parsed
    try {
      parsed = JSON.parse(rawText.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim())
    } catch {
      console.error('avProcessAwbDocs: JSON parse failed:', rawText)
      await db.doc(`av_flight_awbs/${awbId}`).update({ ai_status: 'failed', ai_error: 'Invalid AI JSON', ai_raw_response: rawText.slice(0, 500), updated_at: new Date().toISOString() })
      return
    }

    if (parsed.error) {
      await db.doc(`av_flight_awbs/${awbId}`).update({ ai_status: 'failed', ai_error: parsed.error, updated_at: new Date().toISOString() })
      return
    }

    // Validate & update
    const pieces = Number(parsed.pieces) || 0
    const grossKg = Number(parsed.gross_weight_kg) || 0
    const chwKg = Number(parsed.chw_kg) || 0
    const needsReview = pieces === 0 && grossKg === 0 && chwKg === 0

    await db.doc(`av_flight_awbs/${awbId}`).update({
      iac: parsed.iac || '', pieces, gross_weight_kg: grossKg, chw_kg: chwKg,
      dg: !!parsed.dg, dg_codes: Array.isArray(parsed.dg_codes) ? parsed.dg_codes : [],
      lb: !!parsed.lb, lb_detail: parsed.lb_detail || '',
      shipper_name: parsed.shipper_name || '', consignee_name: parsed.consignee_name || '',
      agent_name: parsed.agent_name || '', shipper_phone: parsed.shipper_phone || '',
      nature_of_goods: parsed.nature_of_goods || '',
      ai_status: needsReview ? 'needs_review' : 'complete',
      ai_error: needsReview ? 'All fields 0 — verify document' : '',
      ai_processed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })

    // Recalc flight totals
    if (flightId) {
      const allAwbs = (await db.collection('av_flight_awbs').where('flight_id', '==', flightId).get()).docs.map(d => d.data())
      await db.doc(`av_flights/${flightId}`).update({
        total_awbs: allAwbs.length, total_pieces: allAwbs.reduce((s, a) => s + (a.pieces || 0), 0),
        total_gross_kg: allAwbs.reduce((s, a) => s + (a.gross_weight_kg || 0), 0),
        total_chw_kg: allAwbs.reduce((s, a) => s + (a.chw_kg || 0), 0),
        has_dg: allAwbs.some(a => a.dg), has_lb: allAwbs.some(a => a.lb), updated_at: new Date().toISOString(),
      })
    }

    // Log AI extraction event
    if (flightId) {
      await db.collection('av_awb_logs').add({
        flight_id: flightId, awb_number: awbNumber,
        event: 'awb_ai_extracted',
        detail: `Pcs: ${pieces}, Gross: ${grossKg} kg, CHW: ${chwKg} kg, IAC: ${parsed.iac || '-'}`,
        user: 'Sistema', timestamp: new Date().toISOString(),
      })
    }

    console.log(`avProcessAwbDocs: SUCCESS ${awbNumber} → pcs=${pieces} gross=${grossKg} chw=${chwKg} iac=${parsed.iac}`)
  } catch (err) {
    console.error('avProcessAwbDocs: EXCEPTION', err.message, err.stack)
    await db.doc(`av_flight_awbs/${awbId}`).update({ ai_status: 'failed', ai_error: err.message, updated_at: new Date().toISOString() }).catch(() => {})
  }
})

// ── avProcessPalletTag (Firestore trigger) — AI extracts Pallet Tag data ──
// Triggers when a new av_pallet_tags doc is created with ai_status='pending'.
// Extracts: pallet_number, date, destination, AWB lines (number, pieces, weight_lbs), notes.

exports.avProcessPalletTag = onDocumentCreated({
  document: 'av_pallet_tags/{tagId}',
  secrets: [ANTHROPIC_API_KEY],
  timeoutSeconds: 120,
  memory: '1GiB',
}, async (event) => {
  const data = event.data.data()
  const tagId = event.params.tagId

  if (data.ai_status !== 'pending') return

  const docUrl = data.doc_url
  if (!docUrl) {
    await db.doc(`av_pallet_tags/${tagId}`).update({ ai_status: 'failed', ai_error: 'No document URL', updated_at: new Date().toISOString() })
    return
  }

  await db.doc(`av_pallet_tags/${tagId}`).update({ ai_status: 'processing', updated_at: new Date().toISOString() })

  try {
    // Load existing AWBs for this flight to help AI match correctly
    const existingAwbSnap = await db.collection('av_flight_awbs').where('flight_id', '==', data.flight_id).get()
    const knownAwbs = existingAwbSnap.docs.map(d => d.data().awb_number).filter(Boolean).sort()
    const awbListHint = knownAwbs.length > 0
      ? `\n\nKNOWN AWBs for this flight (use these as reference to validate your extraction — match against this list when possible):\n${knownAwbs.join('\n')}`
      : ''

    // Fetch document
    const docResp = await fetch(docUrl)
    if (!docResp.ok) {
      await db.doc(`av_pallet_tags/${tagId}`).update({ ai_status: 'failed', ai_error: `Fetch failed: HTTP ${docResp.status}` })
      return
    }
    const docBuf = await docResp.arrayBuffer()
    const docBase64 = Buffer.from(docBuf).toString('base64')

    // Detect content type
    const contentType = docResp.headers.get('content-type') || ''
    let mediaType = 'application/pdf'
    if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) mediaType = 'image/jpeg'
    else if (contentType.includes('image/png')) mediaType = 'image/png'
    else if (contentType.includes('image/webp')) mediaType = 'image/webp'

    console.log(`avProcessPalletTag: doc fetched, size=${(docBuf.byteLength / 1024).toFixed(0)}KB, type=${mediaType}`)

    // Determine source type for Claude API
    const sourceContent = mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: docBase64 } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: docBase64 } }

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() })
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          sourceContent,
          { type: 'text', text: `This is a scanned Pallet Tag document from a cargo warehouse. It is a standard MCL (MinCurl Logistics) form used to record the contents of an airline ULD (Unit Load Device) / pallet.

Extract the following data from this document:

1. **Pallet Number** (ULD number, e.g. "PMC46331QT", "DQF5647AV", "AKE12345AV"). Usually labeled "PALLET NO" or "ULD NO". Include ALL characters exactly as written (letters + digits + suffix).
2. **Flight Number** (e.g. "AV 246", "AV0246", "M4003-BOG"). Usually labeled "FLIGHT NO".
3. **Date** (the date on the form, format YYYY-MM-DD).
4. **Destination** (3-letter airport code, e.g. "BOG", "SDQ"). Usually labeled "DESTINATION", "DEST", or "UNLOAD".
5. **AWB Lines** — a table of Air Waybill entries. Each line has:
   - AWB number (format: 3 digits dash 8 digits, e.g. "729-95079014", "906-13445165")
   - Pieces (number of pieces for this AWB in this pallet)
   - Weight in KG (kilograms) — the numeric value as written on the document
   - Remark (any note, especially lithium battery info like "ELI", "ELIELI", "ELI Section II")
6. **Notes** — any notes at the bottom, especially lithium battery declarations (format: "AWB--pcs--ELI").
7. **Prepared By** — name of person who prepared the tag.

The document may contain ONE or MULTIPLE pallet tags (multiple pages, each page is a separate pallet tag).

Return ONLY a JSON array (no markdown, no explanation). Each element is one pallet tag:
[
  {
    "pallet_number": "string (e.g. PMC46331QT, PAG31133R7)",
    "flight_number": "string",
    "date": "YYYY-MM-DD",
    "destination": "string (3-letter code)",
    "lines": [
      { "awb_number": "string (format: 000-00000000)", "pieces": integer, "weight_kg": number, "remark": "string or empty" }
    ],
    "notes": ["array of note strings, empty if none"],
    "prepared_by": "string or empty"
  }
]

Rules:
- ALWAYS return an array, even if there is only one pallet tag.
- READ EACH DIGIT OF THE AWB NUMBER CAREFULLY. AWB numbers are in the format 3 digits, dash, 8 digits (e.g. "729-95079014"). Do NOT confuse digits — read each one individually from the image. The first 3 digits (prefix) identify the airline and are critical.
- Weight is ALWAYS in KG (kilograms). Return the exact numeric value as printed on the document.
- If Total Weight on the form is 0 or 0.00, that's ok — sum individual line weights.
- AWB numbers must include the dash (e.g. "729-95079014", not "72995079014").
- If a field is illegible, use empty string or 0.
- Include ALL AWB lines, even if weight is 0.
- If an AWB appears multiple times in the same pallet tag, list each occurrence separately.${awbListHint}` },
        ],
      }],
    })

    const rawText = (response.content[0]?.text || '').trim()
    console.log(`avProcessPalletTag: AI response:`, rawText)

    let parsed
    try {
      parsed = JSON.parse(rawText.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim())
    } catch {
      console.error('avProcessPalletTag: JSON parse failed:', rawText)
      await db.doc(`av_pallet_tags/${tagId}`).update({ ai_status: 'failed', ai_error: 'Invalid AI JSON', updated_at: new Date().toISOString() })
      return
    }

    // AI may return an array (multiple pallet tags in one PDF) or a single object
    const pallets = Array.isArray(parsed) ? parsed : [parsed]

    if (pallets.length === 0) {
      await db.doc(`av_pallet_tags/${tagId}`).update({ ai_status: 'failed', ai_error: 'No pallet tags found', updated_at: new Date().toISOString() })
      return
    }

    // Helper: consolidate duplicate AWB lines within a pallet (sum pieces & weight_kg)
    function consolidateLines(rawLines) {
      const map = {}
      for (const l of rawLines) {
        const awb = (l.awb_number || '').trim()
        if (!awb) continue
        const w = Number(l.weight_kg) || Number(l.weight_lbs) || Number(l.weight) || 0
        if (!map[awb]) map[awb] = { awb_number: awb, pieces: 0, weight_kg: 0, remark: '' }
        map[awb].pieces += Number(l.pieces) || 0
        map[awb].weight_kg += w
        if (l.remark && !map[awb].remark) map[awb].remark = l.remark
      }
      return Object.values(map)
    }

    // First pallet updates the original doc, additional pallets create new docs
    for (let i = 0; i < pallets.length; i++) {
      const pt = pallets[i]
      const lines = consolidateLines(pt.lines || [])
      const totalPieces = lines.reduce((s, l) => s + l.pieces, 0)
      const totalWeightKg = lines.reduce((s, l) => s + l.weight_kg, 0)

      const palletData = {
        pallet_number: pt.pallet_number || '',
        date: pt.date || '',
        destination: pt.destination || data.destination || '',
        lines,
        total_pieces: totalPieces,
        total_weight_kg: totalWeightKg,
        notes: Array.isArray(pt.notes) ? pt.notes : [],
        prepared_by: pt.prepared_by || '',
        ai_status: 'complete',
        ai_processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      if (i === 0) {
        // Update the original doc
        await db.doc(`av_pallet_tags/${tagId}`).update(palletData)
      } else {
        // Create additional docs for extra pallets in the same PDF
        await db.collection('av_pallet_tags').add({
          flight_id: data.flight_id,
          doc_url: data.doc_url,
          doc_filename: data.doc_filename,
          screened: false,
          created_at: data.created_at,
          uploaded_by: data.uploaded_by,
          ...palletData,
        })
      }

      console.log(`avProcessPalletTag: SUCCESS [${i + 1}/${pallets.length}] ${pt.pallet_number} → ${lines.length} AWBs, ${totalPieces} pcs, ${totalWeightKg} kg`)

      // Log events for each AWB in this pallet tag
      const logNow = new Date().toISOString()
      for (const line of lines) {
        await db.collection('av_awb_logs').add({
          flight_id: data.flight_id,
          awb_number: line.awb_number,
          event: 'pallet_tag_processed',
          detail: `ULD: ${pt.pallet_number || '?'} · ${line.pieces} pcs · ${line.weight_kg} kg`,
          user: data.uploaded_by || 'Sistema',
          timestamp: logNow,
        })
      }
    }

    // Auto-create missing AWBs found in pallet tags
    const allAwbNumbers = new Set()
    for (const pt of pallets) {
      for (const l of (pt.lines || [])) {
        if (l.awb_number) allAwbNumbers.add(l.awb_number.trim())
      }
    }
    if (allAwbNumbers.size > 0) {
      const existingSnap = await db.collection('av_flight_awbs').where('flight_id', '==', data.flight_id).get()
      const existingNumbers = new Set(existingSnap.docs.map(d => d.data().awb_number))
      const now = new Date().toISOString()
      for (const awbNum of allAwbNumbers) {
        if (!existingNumbers.has(awbNum)) {
          await db.collection('av_flight_awbs').add({
            flight_id: data.flight_id,
            awb_number: awbNum,
            iac: '', pieces: 0, gross_weight_kg: 0, chw_kg: 0,
            dg: false, dg_codes: [], lb: false, lb_detail: '',
            total_pcs_in_pallets: 0, screened_pcs: 0, screening_status: 'pending',
            created_at: now,
          })
          console.log(`avProcessPalletTag: Auto-created AWB ${awbNum} (found in pallet tag, not in flight)`)
          await db.collection('av_awb_logs').add({
            flight_id: data.flight_id, awb_number: awbNum, event: 'awb_created',
            detail: 'Auto-creada desde Pallet Tag', user: 'Sistema', timestamp: now,
          })
        }
      }
    }
  } catch (err) {
    console.error('avProcessPalletTag: EXCEPTION', err.message, err.stack)
    await db.doc(`av_pallet_tags/${tagId}`).update({ ai_status: 'failed', ai_error: err.message, updated_at: new Date().toISOString() }).catch(() => {})
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// ── Google Sheets Sync Agent ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//
// Monitors Google Sheets per client and syncs booking changes to Firestore.
// Config stored in _sheet_sync_configs/{clientId}.
// Day+1 operations: auto-apply.  Same-day: alert only.
//

const crypto = require('crypto')

// ── Sheet Parsing Helpers (ported from AirfreightValidation.tsx) ──

const SHEET_HEADER_ALIASES = [
  ['flight_number', ['flight number', 'flight#', 'flight #', 'vuelo', 'numero de vuelo']],
  ['awb_1st', ['1st leg awb', '1st leg', 'awb 1st leg', '1st awb', '1st leg awb#']],
  ['awb_2nd', ['2nd leg awb', '2nd leg', 'awb 2nd leg', '2nd awb', '2nd leg awb#']],
  ['uld', ['uld', 'uld type', 'uld / loose', 'uld/loose']],
  ['pieces', ['pcs', 'pieces', 'piezas']],
  ['cw', ['cw', 'chw', 'chargeable', 'chargeable wt', 'chargeable weight']],
  ['pickup_from', ['pick up from', 'pickup from', 'pick-up from']],
  ['ready_for_pickup', ['ready for pickup', 'ready', 'ready date', 'ready for pick up']],
  ['lfd', ['lfd', 'last day free', 'last free day', 'free days']],
  ['deliver_to', ['deliver to', 'airline']],
  ['destination', ['dest', 'dest.', 'destination', 'destino']],
  ['cutoff', ['cutoff', 'cut off', 'cutoff time', 'cut-off', 'cut off date/time']],
  ['etd', ['etd', 'departure', 'date & etd time']],
  ['hold_bg', ['hold bg#', 'hold bg #', 'hold bg', 'bag#', 'bag #', 'bg#', 'bg #']],
  ['hold_box', ['hold box#', 'hold box #', 'hold box', 'box#', 'box #']],
  ['battery', ['battery', 'bateria', 'lithium', 'lb', 'lithium battery', 'battery yes/no']],
  ['on_hand_date', ['on-hand date', 'on hand date', 'onhand date', 'on_hand_date', 'on-hand']],
  ['dropped_off_date', ['dropped off date/time', 'dropped off date', 'drop off date/time', 'drop off date', 'dropoff date', 'dropped off']],
]

function sheetParseDate(raw) {
  if (raw === null || raw === undefined || raw === '') return ''
  if (typeof raw === 'number') {
    const d = new Date((raw - 25569) * 86400000)
    if (raw % 1 !== 0) {
      const hh = String(d.getUTCHours()).padStart(2, '0')
      const mm = String(d.getUTCMinutes()).padStart(2, '0')
      return `${d.toISOString().slice(0, 10)}T${hh}:${mm}:00`
    }
    return d.toISOString().slice(0, 10)
  }
  const s = String(raw).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s || /^[a-z]/i.test(s)) return s
  const dateRe = /(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/
  const dateMatch = s.match(dateRe)
  if (dateMatch) {
    const mm = dateMatch[1].padStart(2, '0')
    const dd = dateMatch[2].padStart(2, '0')
    const yearRaw = dateMatch[3]
    const year = yearRaw ? (yearRaw.length === 2 ? '20' + yearRaw : yearRaw) : String(new Date().getFullYear())
    // F6: Validate year — reject clearly invalid years
    const yearNum = parseInt(year, 10)
    if (yearNum < 2020 || yearNum > 2035) return ''
    // F1/sheetParseDate: Preserve time if present after date (e.g. "5/11/2026 09:55")
    const remainder = s.slice(dateMatch.index + dateMatch[0].length).trim()
    const timeMatch = remainder.match(/^(\d{1,2}):(\d{2})/)
    if (timeMatch) {
      const hh = timeMatch[1].padStart(2, '0')
      const mi = timeMatch[2].padStart(2, '0')
      return `${year}-${mm}-${dd}T${hh}:${mi}:00`
    }
    return `${year}-${mm}-${dd}`
  }
  return s
}

function sheetIsYes(val) {
  const v = (val || '').toLowerCase().trim()
  return v === 'y' || v === 'yes' || v === 'si' || v === 'sí' || v === 'true' || v === '1'
}

function sheetNormStr(s) { return (s || '').trim().toUpperCase() }

// F1: Normalize flight number — strip suffixes, standardize hyphen
function normalizeFlightNumber(raw) {
  let s = (raw || '').trim().toUpperCase()
  if (!s || /^(PENDING|TBD|TBA|N\/A)$/i.test(s)) return s
  // Remove known suffixes (e.g. "LA-0543 A18" → "LA-0543", "AR1303 PAX" → "AR1303")
  s = s.replace(/\s+(A\d+|PAX|CAO|LOOSE|CARGO)$/, '')
  // Add standard hyphen if missing (e.g. QT4093 → QT-4093, UC1617 → UC-1617)
  if (!s.includes('-')) {
    const m = s.match(/^([A-Z]{1,3})(\d{3,5})$/)
    if (m) s = `${m[1]}-${m[2]}`
  }
  return s
}

// H1+H5: Check dispatched/closed status using BOTH fields (status + flight_status)
// AND dispatched_at timestamp as backup indicator
function isFlightBlocked(f) {
  if (!f) return false
  const s = (f.flight_status || f.status || '').toLowerCase()
  if (s === 'dispatched' || s === 'closed' || s === 'cancelled') return true
  if (f.dispatched_at) return true
  return false
}

// H7: Structured audit log for flight operations (creation, step2 fallback, enrichment)
function auditFlightEvent(type, data) {
  try {
    db.collection('_sheet_sync_flight_audit').add({
      type,
      ...data,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    })
  } catch (e) {
    console.error('Audit log failed:', e.message)
  }
}

// F2: Normalize destination — strip operational suffixes
function normalizeDest(raw) {
  return (raw || '').trim().toUpperCase().replace(/\s+(LOOSE|PAX|CAO|CARGO)$/, '').trim()
}

// V2: Build unique instance key for a flight (flight_number + ETD date)
function buildInstanceKey(flightNumber, etdOrIso) {
  const fn = normalizeFlightNumber(flightNumber)
  if (!fn || /^(PENDING|TBD|TBA|N\/A)$/i.test(fn)) return null
  const date = (etdOrIso || '').slice(0, 10)
  if (!date || date.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fn + '_DRAFT'
  return fn + '_' + date
}

// V2: Unified flight finder — exact match by instance key, no fuzzy
async function findOrCreateFlight(rawFlight, etd, cutoff, airline, dest, allFlights, dryRun, dryRunLog) {
  const fn = normalizeFlightNumber(rawFlight)
  const etdDate = (etd || '').slice(0, 10)
  const isPending = !fn || /^(PENDING|TBD|TBA|N\/A)$/i.test(fn)
  const now = new Date().toISOString()

  if (isPending) {
    const pendingMonthKey = now.slice(0, 7)
    let target = allFlights.find(f =>
      sheetNormStr(f.flight_number || '') === 'PENDING' &&
      !isFlightBlocked(f) &&
      ((!f.flight_datetime) || (f.flight_datetime || '').startsWith(pendingMonthKey))
    )
    if (target) return { flight: target, action: 'matched_pending' }
    if (dryRun) {
      dryRunLog.push({ type: 'would_create_flight', flight_number: 'PENDING', etd: etd || null })
      return { flight: null, action: 'would_create_pending' }
    }
    const pendingDatetime = etdDate ? etdDate + 'T00:00:00' : now.slice(0, 10) + 'T00:00:00'
    const flightData = {
      airline: airline || 'PENDING', flight_number: 'PENDING',
      flight_datetime: pendingDatetime,
      cutoff_datetime: null, flight_instance_key: null,
      destinations: dest ? [normalizeDest(dest)] : [],
      status: 'open',
      created_by: 'sheet_sync_agent', created_at: now,
    }
    const docRef = await db.collection('airfreight_flights').add(flightData)
    const newFlight = { ...flightData, id: docRef.id }
    allFlights.push(newFlight)
    auditFlightEvent('flight_created', { fn: 'findOrCreateFlight', flight_id: docRef.id, flight_number: 'PENDING', etd: flightData.flight_datetime })
    return { flight: newFlight, action: 'created_pending' }
  }

  const targetKey = buildInstanceKey(fn, etdDate)

  // Exact match by instance key (V2 core — no fuzzy)
  let target = allFlights.find(f =>
    f.flight_instance_key === targetKey &&
    f.flight_type !== 'local_job' &&
    !isFlightBlocked(f)
  )

  if (target) {
    // Enrich airline/dest if needed
    if (!dryRun) {
      const enrichUpdates = {}
      if (airline && airline.trim().length >= 2 && /[a-z]/i.test(airline) && (target.airline === 'Unknown' || !target.airline)) {
        enrichUpdates.airline = airline.trim()
        target.airline = enrichUpdates.airline
      }
      if (dest && (!target.destinations || target.destinations.length === 0)) {
        enrichUpdates.destinations = [normalizeDest(dest)]
        target.destinations = enrichUpdates.destinations
      }
      if (Object.keys(enrichUpdates).length > 0) {
        await db.collection('airfreight_flights').doc(target.id).update(enrichUpdates)
      }
    }
    return { flight: target, action: 'matched' }
  }

  // Check if blocked flight exists with this key
  const blockedMatch = allFlights.find(f =>
    f.flight_instance_key === targetKey && isFlightBlocked(f)
  )
  if (blockedMatch) {
    return { flight: null, action: 'blocked', blockedFlight: blockedMatch }
  }

  // Check for DRAFT flight (same flight number, no date) — upgrade it
  const draftKey = fn + '_DRAFT'
  const draftFlight = allFlights.find(f =>
    f.flight_instance_key === draftKey && !isFlightBlocked(f)
  )
  if (draftFlight && etdDate) {
    if (dryRun) {
      dryRunLog.push({ type: 'would_upgrade_draft', flight_id: draftFlight.id, from_key: draftKey, to_key: targetKey })
      return { flight: draftFlight, action: 'would_upgrade_draft' }
    }
    const updates = { flight_datetime: etd, flight_instance_key: targetKey, status: 'open' }
    if (cutoff) updates.cutoff_datetime = cutoff
    await db.collection('airfreight_flights').doc(draftFlight.id).update(updates)
    Object.assign(draftFlight, updates)
    auditFlightEvent('draft_upgraded', { fn: 'findOrCreateFlight', flight_id: draftFlight.id, flight_number: fn, old_key: draftKey, new_key: targetKey })
    return { flight: draftFlight, action: 'upgraded_draft' }
  }

  // Create new flight
  if (dryRun) {
    dryRunLog.push({ type: 'would_create_flight', flight_number: fn, instance_key: targetKey, etd: etd || null })
    return { flight: null, action: 'would_create' }
  }

  const flightData = {
    airline: airline || 'Unknown', flight_number: fn,
    flight_datetime: etd || null, cutoff_datetime: cutoff || null,
    flight_instance_key: targetKey,
    destinations: dest ? [normalizeDest(dest)] : [],
    status: etd ? 'open' : 'draft',
    created_by: 'sheet_sync_agent', created_at: now,
  }
  const docRef = await db.collection('airfreight_flights').add(flightData)
  const newFlight = { ...flightData, id: docRef.id }
  allFlights.push(newFlight)
  auditFlightEvent('flight_created', { fn: 'findOrCreateFlight', flight_id: docRef.id, flight_number: fn, instance_key: targetKey, etd: flightData.flight_datetime, airline: flightData.airline })
  return { flight: newFlight, action: 'created' }
}

// V2: Remove AWB from a booking (for cleanup of orphans)
async function removeAwbFromBooking(bookingId, awbNumber) {
  const awbNorm = sheetNormStr(awbNumber)
  const bookingRef = db.collection('airfreight_bookings').doc(bookingId)
  let removed = false
  await db.runTransaction(async (t) => {
    const snap = await t.get(bookingRef)
    if (!snap.exists) return
    const bData = snap.data()
    const lines = [...(bData.awb_lines || [])]
    const idx = lines.findIndex(l => sheetNormStr(l.awb_number || '') === awbNorm)
    if (idx < 0) return
    lines.splice(idx, 1)
    const updatedData = { ...bData, awb_lines: lines }
    t.update(bookingRef, {
      awb_lines: lines,
      pieces: lines.reduce((s, l) => s + (l.pieces || 0), 0),
      awb_numbers_normalized: computeAwbNumbersNormalized(updatedData),
      ...(lines.length === 0 ? { status: 'empty' } : {}),
    })
    removed = true
  })
  return removed
}

// F8: Normalize ULD — clean multiline artifacts
function normalizeUld(raw) {
  let s = (raw || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase()
  if (s === 'BUP OR LOOSE') s = 'LOOSE'
  return s
}

/** Convert 0-based column index to A1 column letter (0→A, 25→Z, 26→AA) */
function colIndexToLetter(idx) {
  let letter = ''
  let n = idx
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter
    n = Math.floor(n / 26) - 1
  }
  return letter
}

const MONTH_NAMES_ES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
  'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE']

const MONTH_NAMES_EN = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER']

/**
 * H10: Find tabs for the current month, plus adjacent months near month boundaries.
 * - Day 1-7:   previous month + current month (7-day grace for closing previous month)
 * - Day 8-24:  current month only (normal operation)
 * - Day 25-31: current month + next month (7 days ahead for upcoming bookings)
 * Order: previous → current → next (dedup "last wins" = most recent tab prevails).
 */
function findTabByMonth(allTabTitles, month, year) {
  const nameEs = MONTH_NAMES_ES[month]
  const nameEn = MONTH_NAMES_EN[month]
  const yearStr = String(year)
  const matching = allTabTitles.filter(title => {
    const t = title.toUpperCase()
    return (t.includes(nameEs) || t.includes(nameEn)) &&
      (t.includes(yearStr) || t.includes(yearStr.slice(2)))
  })
  return matching.length > 0 ? matching[matching.length - 1] : null
}

function findMonthTabs(allTabTitles, pattern) {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() // 0-based
  const day = now.getDate()
  const result = []
  // Day 1-7: also read previous month (grace period for closing)
  if (day <= 7) {
    const prevMonth = month === 0 ? 11 : month - 1
    const prevYear = month === 0 ? year - 1 : year
    const prevTab = findTabByMonth(allTabTitles, prevMonth, prevYear)
    if (prevTab) result.push({ tabTitle: prevTab, monthOffset: -1 })
  }

  // Always read current month
  const currentTab = findTabByMonth(allTabTitles, month, year)
  if (currentTab) result.push({ tabTitle: currentTab, monthOffset: 0 })

  // Day 25+: also read next month (upcoming bookings)
  if (day >= 25) {
    const nextMonth = month === 11 ? 0 : month + 1
    const nextYear = month === 11 ? year + 1 : year
    const nextTab = findTabByMonth(allTabTitles, nextMonth, nextYear)
    if (nextTab) result.push({ tabTitle: nextTab, monthOffset: 1 })
  }

  return result
}

/**
 * Detect headers and parse rows from a 2D array of sheet values.
 * Returns { colMap, headerRowIdx, rows } where rows are parsed ExcelRow-like objects.
 */
function parseSheetRows(rawRows) {
  let headerRowIdx = -1
  let colMap = {}

  // Negative keywords: headers containing these are arrival/import data, not outbound
  const NEGATIVE_KEYWORDS = ['inbound', 'inbond', 'eta', 'arrival', 'import', 'incoming']

  for (let i = 0; i < Math.min(rawRows.length, 20); i++) {
    const row = rawRows[i] || []
    // Collect ALL candidate columns per key (not just first match)
    const candidates = {} // key -> [{col, headerLen}]
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j] ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
      if (!cell) continue
      for (const [key, aliases] of SHEET_HEADER_ALIASES) {
        if (aliases.some(a => cell === a || cell.includes(a))) {
          if (!candidates[key]) candidates[key] = []
          candidates[key].push({ col: j, headerLen: cell.length, header: cell })
        }
      }
    }
    // Resolve each key: discard headers with negative keywords, pick shortest
    const tempMap = {}
    for (const [key, options] of Object.entries(candidates)) {
      let filtered = options
      if (options.length > 1) {
        const clean = options.filter(o => !NEGATIVE_KEYWORDS.some(nk => o.header.includes(nk)))
        if (clean.length > 0) filtered = clean
      }
      // Pick leftmost column (after negative filtering)
      filtered.sort((a, b) => a.col - b.col)
      tempMap[key] = filtered[0].col
    }
    const matchCount = Object.keys(tempMap).length
    if (matchCount >= 3) { headerRowIdx = i; colMap = tempMap; break }
  }

  if (headerRowIdx < 0) return { colMap: {}, headerRowIdx: -1, rows: [] }

  // Detect headerless docs_in_drive column
  if (!('docs_in_drive' in colMap)) {
    const sampleRows = rawRows.slice(headerRowIdx + 1, headerRowIdx + 6)
    for (let j = 0; j < 3; j++) {
      if (Object.values(colMap).includes(j)) continue
      if (sampleRows.some(r => /docs/i.test(String((r || [])[j] || '')))) {
        colMap['docs_in_drive'] = j
        break
      }
    }
  }

  const col = (r, key) => key in colMap ? String((r || [])[colMap[key]] ?? '').trim() : ''

  const allDataRows = rawRows.slice(headerRowIdx + 1)
  const dataRows = []
  // Track continuation rows (empty AWB but with hold data) to merge into parent
  const continuationHolds = [] // { parentIdx, bag, box }
  let lastAwbRowIdx = -1

  for (let i = 0; i < allDataRows.length; i++) {
    const r = allDataRows[i]
    const awb1 = col(r, 'awb_1st')
    const awb2 = col(r, 'awb_2nd')
    const holdBgVal = col(r, 'hold_bg')
    const holdBoxVal = col(r, 'hold_box')

    if (!awb1 && !awb2) {
      // Continuation row: no AWB but has hold data → belongs to previous AWB
      if (holdBgVal && lastAwbRowIdx >= 0) {
        const holdBgLower = holdBgVal.toLowerCase().trim()
        if (holdBgLower && holdBgLower !== 'no hold' && holdBgLower !== 'no' && holdBgLower !== 'n/a') {
          continuationHolds.push({ parentIdx: lastAwbRowIdx, bag: holdBgVal, box: holdBoxVal || '' })
        }
      }
      continue
    }
    const awbCheck = (awb1 || awb2 || '').trim()
    if (!/\d{3}-\d+/.test(awbCheck)) continue
    lastAwbRowIdx = dataRows.length
    dataRows.push({ r, sheetRowIdx: headerRowIdx + 1 + i })
  }

  const rows = dataRows.map(({ r, sheetRowIdx }) => {
    const holdBgVal = col(r, 'hold_bg')
    const holdBoxVal = col(r, 'hold_box')
    return {
      flight: normalizeFlightNumber(col(r, 'flight_number')),
      awb1st: col(r, 'awb_1st'),
      awb2nd: col(r, 'awb_2nd'),
      uld: normalizeUld(col(r, 'uld')),
      pcs: Number(col(r, 'pieces')) || 0,
      cw: Number(col(r, 'cw')) || 0,
      pickupFrom: String(col(r, 'pickup_from')).replace(/\.0$/, ''),
      readyForPickup: sheetParseDate(colMap['ready_for_pickup'] != null ? (r || [])[colMap['ready_for_pickup']] : ''),
      lastDayFree: sheetParseDate(colMap['lfd'] != null ? (r || [])[colMap['lfd']] : ''),
      deliverTo: col(r, 'deliver_to'),
      dest: normalizeDest(col(r, 'destination')),
      etd: sheetParseDate(colMap['etd'] != null ? (r || [])[colMap['etd']] : ''),
      cutoff: sheetParseDate(colMap['cutoff'] != null ? (r || [])[colMap['cutoff']] : ''),
      holdBg: holdBgVal,
      holdBox: holdBoxVal,
      holds: [], // will be populated below
      battery: sheetIsYes(col(r, 'battery')),
      docsInDrive: sheetIsYes(col(r, 'docs_in_drive')) || /^docs(\s+(in\s+drive|ok|si|yes))?$/i.test(col(r, 'docs_in_drive').trim()),
      sheetRowIdx, // original 0-based row index in the sheet
      onHandDateCell: col(r, 'on_hand_date'),
      droppedOffDateCell: col(r, 'dropped_off_date'),
    }
  })

  // Build holds array for each row: first from the row itself, then continuation rows
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const bg = (r.holdBg || '').trim()
    const bx = (r.holdBox || '').trim()
    const bgLower = bg.toLowerCase()
    const isNoHold = !bg || bgLower === 'no hold' || bgLower === 'no' || bgLower === 'n/a'
    const isPending = bgLower === 'pending' || bgLower === 'pendiente'
    if (!isNoHold && !isPending && bg) {
      r.holds.push({ bag: bg, box: bx })
    }
  }
  // Merge continuation holds into parent rows
  for (const ch of continuationHolds) {
    if (ch.parentIdx >= 0 && ch.parentIdx < rows.length) {
      rows[ch.parentIdx].holds.push({ bag: ch.bag, box: ch.box })
    }
  }

  return { colMap, headerRowIdx, rows }
}

/**
 * Compute a stable hash for a parsed row (for change detection).
 */
function rowHash(row) {
  const holdsStr = (row.holds || []).map(h => `${h.bag}:${h.box}`).join(',')
  const parts = [
    row.flight, row.awb1st, row.awb2nd, row.uld,
    String(row.pcs), String(row.cw), row.pickupFrom,
    row.readyForPickup, row.lastDayFree, row.deliverTo,
    row.dest, row.etd, row.cutoff, row.holdBg, row.holdBox, holdsStr,
    row.battery ? 'Y' : 'N', row.docsInDrive ? 'Y' : 'N',
  ].map(s => sheetNormStr(s))
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}

/**
 * Compare a sheet row against a system AWB line and return diffs.
 */
function computeDiffs(ex, sys) {
  const diffs = []
  const exFlightNorm = normalizeFlightNumber(ex.flight)
  const sysFlightNorm = normalizeFlightNumber(sys.flightNumber)
  const exIsPending = !exFlightNorm || /^(PENDING|TBD|TBA|N\/A)$/i.test(exFlightNorm)
  const sysIsPending = !sysFlightNorm || /^(PENDING|TBD|TBA|N\/A)$/i.test(sysFlightNorm)
  // V2: Detect flight changes using normalizeFlightNumber (consistent with instance key)
  if (exFlightNorm !== sysFlightNorm && !exIsPending) {
    diffs.push({ field: 'Vuelo', new_value: ex.flight, old_value: sys.flightNumber || 'PENDING' })
  }
  // V2: Same flight number, different date = different flight instance → trigger move
  if (exFlightNorm === sysFlightNorm && !exIsPending && !sysIsPending) {
    const exDate = (ex.etd || '').slice(0, 10)
    const sysDate = (sys.etd || '').slice(0, 10)
    if (exDate && sysDate && exDate !== sysDate) {
      diffs.push({ field: 'Vuelo', new_value: ex.flight, old_value: sys.flightNumber })
    }
  }
  if (ex.pcs !== sys.pcs) diffs.push({ field: 'PCS', new_value: String(ex.pcs), old_value: String(sys.pcs) })
  if (Math.abs(ex.cw - sys.cw) > 0.5) diffs.push({ field: 'CW', new_value: String(ex.cw), old_value: String(sys.cw) })
  const exUld = normalizeUld(ex.uld) || 'LOOSE'
  const sysUld = normalizeUld(sys.uld) || 'LOOSE'
  if (exUld !== sysUld) diffs.push({ field: 'ULD', new_value: exUld, old_value: sysUld })
  if (normalizeDest(ex.dest) !== normalizeDest(sys.dest)) diffs.push({ field: 'Dest', new_value: normalizeDest(ex.dest), old_value: sys.dest })
  if (sheetNormStr(ex.awb2nd) !== sheetNormStr(sys.awb2nd)) diffs.push({ field: '2nd Leg', new_value: ex.awb2nd, old_value: sys.awb2nd })
  const exPickup = sheetNormStr(String(ex.pickupFrom || '').replace(/\.0$/, ''))
  const sysPickup = sheetNormStr(String(sys.pickupFrom || '').replace(/\.0$/, ''))
  if (exPickup !== sysPickup) diffs.push({ field: 'Pickup', new_value: ex.pickupFrom, old_value: sys.pickupFrom })
  if (sheetNormStr(String(ex.readyForPickup ?? '').slice(0, 10)) !== sheetNormStr(String(sys.readyForPickup ?? '').slice(0, 10))) diffs.push({ field: 'Ready', new_value: ex.readyForPickup, old_value: sys.readyForPickup })
  if (sheetNormStr(String(ex.lastDayFree ?? '').slice(0, 10)) !== sheetNormStr(String(sys.lastDayFree ?? '').slice(0, 10))) diffs.push({ field: 'LFD', new_value: ex.lastDayFree, old_value: sys.lastDayFree })
  if (ex.docsInDrive !== sys.docsInDrive) diffs.push({ field: 'Docs/Drive', new_value: ex.docsInDrive ? 'YES' : 'NO', old_value: sys.docsInDrive ? 'YES' : 'NO' })
  // Hold comparison
  const exHoldLower = (ex.holdBg || '').toLowerCase().trim()
  const exHoldStatus = (!exHoldLower || exHoldLower === 'no hold' || exHoldLower === 'no' || exHoldLower === 'n/a') ? 'NO HOLD' : (exHoldLower === 'pending' || exHoldLower === 'pendiente') ? 'PENDING' : 'HOLD'
  const sysHoldStatus = sys.holdStatus || 'NO HOLD'
  if (exHoldStatus !== sysHoldStatus) {
    diffs.push({ field: 'Hold', new_value: exHoldStatus, old_value: sysHoldStatus })
  }
  // Hold bag/box value comparison (when both are HOLD, check if values changed)
  if (exHoldStatus === 'HOLD' && sysHoldStatus === 'HOLD') {
    const exHolds = (ex.holds || []).map(h => `${h.bag}|${h.box}`).sort().join(';;')
    const sysHolds = (sys.holds || []).map(h => `${h.bag}|${h.box}`).sort().join(';;')
    if (exHolds !== sysHolds) {
      diffs.push({ field: 'Holds', new_value: String((ex.holds || []).length) + ' holds', old_value: String((sys.holds || []).length) + ' holds' })
    }
  }
  // New hold with continuation rows (ex has holds, system has none)
  if (exHoldStatus !== 'HOLD' && (ex.holds || []).length > 0 && (sys.holds || []).length === 0) {
    // holds from continuation rows only, holdBg itself is NO HOLD — push holds diff
  }
  if (ex.battery !== sys.battery) diffs.push({ field: 'Battery', new_value: ex.battery ? 'Y' : 'N', old_value: sys.battery ? 'Y' : 'N' })
  // ETD comparison (full string — hour matters for flights)
  const exEtdNorm = sheetNormStr(ex.etd || '')
  const sysEtdNorm = sheetNormStr(sys.etd || '')
  if (exEtdNorm && exEtdNorm !== sysEtdNorm) diffs.push({ field: 'ETD', new_value: ex.etd, old_value: sys.etd })
  // CutOff comparison (date only — first 10 chars)
  const exCutNorm = sheetNormStr((ex.cutoff || '').slice(0, 10))
  const sysCutNorm = sheetNormStr((sys.cutoff || '').slice(0, 10))
  if (exCutNorm && exCutNorm !== sysCutNorm) diffs.push({ field: 'CutOff', new_value: ex.cutoff, old_value: sys.cutoff })
  return diffs
}

/**
 * Build system lookup maps from Firestore bookings.
 */
function buildSystemMaps(bookings, flightMap, builtAwbs, receivedAwbs, docReceptionDates) {
  const byAwb1 = new Map()
  const byAwb2 = new Map()
  const _builtAwbs = builtAwbs || new Set()
  const _receivedAwbs = receivedAwbs || new Set()
  const _docReceptionDates = docReceptionDates || new Map()

  for (const b of bookings) {
    const flight = flightMap.get(b.flight_id)
    if (!b.awb_lines) continue
    b.awb_lines.forEach((line, idx) => {
      const holdStatus = line.hold === true ? 'HOLD' : line.hold === 'pending' ? 'PENDING' : 'NO HOLD'
      const norm1 = sheetNormStr(line.awb_number || '')
      const norm2 = sheetNormStr(line.awb_2nd_leg || '')
      // ON-HAND DATE: from doc reception created_at (earliest)
      const docRecDate = _docReceptionDates.get(norm1) || _docReceptionDates.get(norm2) || null
      // DROPPED OFF: from flight dispatched_at (when flight status changed to "dispatched")
      const flightDispatchedAt = (flight && flight.dispatched_at)
        ? (flight.dispatched_at.toDate ? flight.dispatched_at.toDate().toISOString() : flight.dispatched_at)
        : null
      const sys = {
        bookingId: b.id, flightId: b.flight_id,
        clientId: b.client_id || '', clientName: b.client_name || '',
        flightNumber: (flight && flight.flight_number) || b.flight_number || '',
        airline: (flight && flight.airline) || b.airline || '',
        etd: (flight && flight.flight_datetime) || '',
        cutoff: (flight && flight.cutoff_datetime) || '',
        flightStatus: (flight && (flight.flight_status || flight.status)) || '',
        awbIndex: idx, awb1st: line.awb_number || '', awb2nd: line.awb_2nd_leg || '',
        uld: (line.uld_type || '').toUpperCase(),
        pcs: line.pieces || 0, cw: line.chargeable_weight || 0,
        dest: (b.destination_id || '').toUpperCase(),
        pickupFrom: line.pickup_from || '',
        readyForPickup: line.ready_for_pickup || b.ready_for_pickup || '',
        lastDayFree: line.last_day_free || b.last_day_free || '',
        docsInDrive: !!line.docs_in_drive,
        onHand: !!line.on_hand, dispatched: !!line.dispatched,
        built: _builtAwbs.has(norm1) || _builtAwbs.has(norm2),
        received: _receivedAwbs.has(norm1) || _receivedAwbs.has(norm2),
        docReceptionDate: docRecDate,
        flightDispatchedAt: flightDispatchedAt,
        dropOffTime: line.drop_off_time || null,
        dispatchedAt: line.dispatched_at || null,
        holdStatus, battery: !!line.battery,
        holdBg: (line.holds && line.holds[0]) ? line.holds[0].bag || '' : '',
        holdBox: (line.holds && line.holds[0]) ? line.holds[0].box || '' : '',
        holds: (line.holds || []).map(h => ({ bag: h.bag || '', box: h.box || '' })),
        hasBilling: false, // Simplified — full billing check would require extra query
      }
      if (sys.awb1st) byAwb1.set(norm1, sys)
      if (sys.awb2nd) byAwb2.set(norm2, sys)
    })
  }
  return { byAwb1, byAwb2 }
}

/**
 * Apply a single diff row to Firestore (update existing AWB line fields).
 * Only handles same-flight field updates (not flight moves).
 */
/**
 * Move AWB from PENDING flight booking to real flight booking.
 * Removes AWB line from PENDING booking, adds to target flight booking (or creates one).
 */
/**
 * A5-FIX: Update doc_reception.booking_id when an AWB moves between bookings.
 * Matches by 1st leg (awb_number) and optionally 2nd leg within the old booking.
 * Called after any AWB move (PENDING→real, real→real, frontend reassign).
 */

/**
 * Reconcile orphan doc_receptions (booking_id == null) when a new booking is created.
 * Only links DRs that have no booking assigned (respects human priority).
 * Only writes warehouse_status if not already set (won't downgrade 'R' to 'D').
 * Called exclusively on booking CREATION paths — not on updates or moves.
 */
async function reconcileOrphanDocReceptions(awbNorms, bookingId, flightId) {
  if (!awbNorms || awbNorms.length === 0 || !bookingId) return { linked: 0 }

  let linked = 0
  for (const awbNorm of awbNorms) {
    if (!awbNorm) continue
    const orphanSnap = await db.collection('airfreight_doc_receptions')
      .where('booking_id', '==', null)
      .where('awb_normalized', '==', awbNorm)
      .limit(5)
      .get()

    for (const orphan of orphanSnap.docs) {
      await orphan.ref.update({
        booking_id: bookingId,
        flight_id: flightId || null,
        reconciled_by: 'sheet_sync_agent',
        reconciled_at: new Date().toISOString(),
      })
      linked++
    }
  }

  // Sync warehouse_status + weight from linked doc_receptions to booking awb_lines
  if (linked > 0) {
    // Gather status/weight from the linked orphan doc_receptions
    const drStatusMap = {} // awbNorm -> { status, weight }
    for (const awbNorm of awbNorms) {
      if (!awbNorm) continue
      const drSnap = await db.collection('airfreight_doc_receptions')
        .where('booking_id', '==', bookingId)
        .where('awb_normalized', '==', awbNorm)
        .limit(1)
        .get()
      if (!drSnap.empty) {
        const drData = drSnap.docs[0].data()
        drStatusMap[awbNorm] = {
          isComplete: drData.status === 'complete',
          weight: drData.weight || 0,
        }
      }
    }

    const bookingRef = db.collection('airfreight_bookings').doc(bookingId)
    await db.runTransaction(async (t) => {
      const snap = await t.get(bookingRef)
      if (!snap.exists) return
      const bData = snap.data()
      const lines = [...(bData.awb_lines || [])]
      let changed = false
      for (let i = 0; i < lines.length; i++) {
        const lineNorm1 = normalizeAwbForIndex(lines[i].awb_2nd_leg)
        const lineNorm2 = normalizeAwbForIndex(lines[i].awb_number)
        const matchNorm = awbNorms.find(n => n === lineNorm1 || n === lineNorm2)
        if (!matchNorm) continue
        const drInfo = drStatusMap[matchNorm]
        if (!drInfo) continue

        // Determine correct warehouse_status: 'R' if physical complete, 'D' if only documented
        const targetStatus = drInfo.isComplete ? 'R' : 'D'
        const currentStatus = lines[i].warehouse_status
        // Only upgrade: null→D, null→R, D→R. Never downgrade R→D
        if (!currentStatus || (currentStatus === 'D' && targetStatus === 'R')) {
          const updates = { warehouse_status: targetStatus }
          if (drInfo.isComplete) updates.on_hand = true
          if (drInfo.weight > 0 && !lines[i].weight) updates.weight = drInfo.weight
          lines[i] = { ...lines[i], ...updates }
          changed = true
        }
      }
      if (changed) {
        t.update(bookingRef, { awb_lines: lines })
      }
    })
  }

  return { linked }
}

async function reconcileDocReceptionBookingId(awb1st, awb2nd, oldBookingId, newBookingId) {
  if (!oldBookingId || !newBookingId || oldBookingId === newBookingId) return { ok: true, msg: 'No booking change' }

  let updated = 0
  const norm1st = sheetNormStr(awb1st)
  const norm2nd = sheetNormStr(awb2nd)

  // Find doc_receptions in the old booking that match this AWB
  const drSnap = await db.collection('airfreight_doc_receptions')
    .where('booking_id', '==', oldBookingId)
    .get()

  for (const drDoc of drSnap.docs) {
    const dr = drDoc.data()
    const drAwb1 = sheetNormStr(dr.awb_number)
    const drAwb2 = sheetNormStr(dr.awb_2nd_leg)

    // Match if 1st leg matches, or if 2nd leg matches
    const matches = (norm1st && (drAwb1 === norm1st || drAwb2 === norm1st)) ||
                    (norm2nd && (drAwb1 === norm2nd || drAwb2 === norm2nd))

    if (matches) {
      await drDoc.ref.update({ booking_id: newBookingId })
      updated++
    }
  }

  return { ok: true, msg: `Updated ${updated} doc_reception(s) booking_id → ${newBookingId.slice(0, 8)}` }
}

async function applyPendingToReal(ex, sys, diffs, allFlights, dryRun, dryRunLog) {
  const sysFlightNorm = sheetNormStr(sys.flightNumber)
  if (sysFlightNorm !== 'PENDING') {
    return { ok: false, msg: 'Flight change between real flights — requires manual review' }
  }

  const rawFlight = (ex.flight || '').trim()
  const now = new Date().toISOString()

  // V2: Use findOrCreateFlight (exact instance key, no fuzzy)
  const result = await findOrCreateFlight(rawFlight, ex.etd, ex.cutoff, ex.deliverTo, ex.dest, allFlights, dryRun, dryRunLog || [])
  if (result.action === 'blocked') {
    return { ok: false, msg: `Target flight ${rawFlight} is dispatched/closed — cannot move AWB` }
  }
  if (dryRun) {
    (dryRunLog || []).push({ type: 'would_move_pending_to_real', awb: ex.awb1st, from: 'PENDING', to: rawFlight, flight_action: result.action })
    return { ok: true, msg: `[DRY-RUN] AWB ${ex.awb1st} would move PENDING → ${rawFlight}` }
  }
  const targetFlight = result.flight
  if (!targetFlight) return { ok: false, msg: `Could not find or create flight ${rawFlight}` }

  // Apply non-flight diffs to build the line update
  const nonFlightDiffs = diffs.filter(d => d.field !== 'Vuelo')
  function applyLineDiffs(line) {
    for (const d of nonFlightDiffs) {
      if (d.field === 'PCS') line.pieces = ex.pcs
      if (d.field === 'CW') line.chargeable_weight = ex.cw
      if (d.field === 'ULD') line.uld_type = ex.uld || null
      if (d.field === '2nd Leg') line.awb_2nd_leg = ex.awb2nd || null
      if (d.field === 'Battery') line.battery = ex.battery
      if (d.field === 'Pickup') line.pickup_from = ex.pickupFrom || null
      if (d.field === 'Ready') line.ready_for_pickup = ex.readyForPickup || null
      if (d.field === 'LFD') line.last_day_free = ex.lastDayFree || null
      if (d.field === 'Docs/Drive') line.docs_in_drive = ex.docsInDrive || false
    }
    return line
  }

  // V2: Atomic move — find/create target booking, then single transaction
  const clientId = sys.clientId
  const clientName = sys.clientName
  const awbToFind = sheetNormStr(ex.awb1st)
  const pendingBookingRef = db.collection('airfreight_bookings').doc(sys.bookingId)

  const existingSnap = await db.collection('airfreight_bookings')
    .where('flight_id', '==', targetFlight.id)
    .where('client_id', '==', clientId)
    .where('booking_type', '==', 'ecommerce')
    .get()
  const existingBooking = existingSnap.docs[0]

  // Pre-create target booking ref if needed (for atomic transaction)
  let targetBookingRef = existingBooking ? existingBooking.ref : db.collection('airfreight_bookings').doc()
  const isNewBooking = !existingBooking

  let moveResult = null
  await db.runTransaction(async (t) => {
    // All reads FIRST (Firestore requires reads before writes)
    const sourceSnap = await t.get(pendingBookingRef)
    const targetSnap = isNewBooking ? null : await t.get(targetBookingRef)

    if (!sourceSnap.exists) throw new Error('PENDING booking not found')
    const sourceData = sourceSnap.data()
    const sourceLines = [...(sourceData.awb_lines || [])]
    const idx = sourceLines.findIndex(l => sheetNormStr(l.awb_number || '') === awbToFind)
    if (idx < 0) { moveResult = 'already_moved'; return }

    const movedLine = applyLineDiffs({ ...sourceLines[idx] })
    sourceLines.splice(idx, 1)

    // Update source (remove line)
    const updatedSource = { ...sourceData, awb_lines: sourceLines }
    t.update(pendingBookingRef, {
      awb_lines: sourceLines,
      pieces: sourceLines.reduce((s, l) => s + (l.pieces || 0), 0),
      awb_numbers_normalized: computeAwbNumbersNormalized(updatedSource),
    })

    // Write to target
    if (isNewBooking) {
      const newBookingData = {
        flight_id: targetFlight.id, flight_number: targetFlight.flight_number || null,
        airline: targetFlight.airline || '', booking_type: 'ecommerce',
        client_id: clientId, client_name: clientName,
        status: 'submitted', created_by: 'sheet_sync_agent', created_at: now,
        change_count: 0, modified_seen: true, change_log: [], documents: {},
        destination_id: normalizeDest(ex.dest) || '', awb_lines: [movedLine],
        pieces: movedLine.pieces || 0, hold: !!movedLine.hold, on_hand: false,
      }
      newBookingData.awb_numbers_normalized = computeAwbNumbersNormalized(newBookingData)
      t.set(targetBookingRef, newBookingData)
    } else {
      const targetData = targetSnap.data()
      const targetLines = [...(targetData.awb_lines || [])]
      if (targetLines.some(l => sheetNormStr(l.awb_number || '') === awbToFind)) return // idempotent
      targetLines.push(movedLine)
      const updatedTarget = { ...targetData, awb_lines: targetLines }
      t.update(targetBookingRef, {
        awb_lines: targetLines,
        pieces: targetLines.reduce((s, l) => s + (l.pieces || 0), 0),
        awb_numbers_normalized: computeAwbNumbersNormalized(updatedTarget),
      })
    }
    moveResult = 'moved'
  })

  if (moveResult === 'already_moved') return { ok: true, msg: `AWB ${ex.awb1st} already moved from PENDING (idempotent skip)` }

  // Reconcile doc_receptions
  await reconcileDocReceptionBookingId(ex.awb1st, ex.awb2nd, sys.bookingId, targetBookingRef.id)
  if (isNewBooking) {
    const awbNorms = [normalizeAwbForIndex(ex.awb1st), normalizeAwbForIndex(ex.awb2nd)].filter(Boolean)
    await reconcileOrphanDocReceptions(awbNorms, targetBookingRef.id, targetFlight.id)
  }

  return { ok: true, msg: `AWB ${ex.awb1st} moved from PENDING → ${rawFlight}` }
}

/**
 * A4-FIX: Move AWB from one real flight to another (R4 compliance).
 * Pre-conditions: AWB must NOT be built or dispatched, target must NOT be same-day.
 * Preserves ALL line fields (warehouse_status, on_hand, screening, etc.)
 * and reconciles doc_reception.booking_id.
 */
async function applyRealToReal(ex, sys, diffs, allFlights, dryRun, dryRunLog) {
  // Safety checks (R5 compliance + gate de estado)
  if (sys.built) return { ok: false, msg: `AWB ${ex.awb1st} is built — cannot auto-move between flights` }
  if (sys.dispatched) return { ok: false, msg: `AWB ${ex.awb1st} is dispatched — cannot auto-move between flights` }
  if (sys.received) return { ok: false, msg: `AWB ${ex.awb1st} has reception activity — cannot auto-move, requires manual review` }

  const rawFlight = (ex.flight || '').trim()
  const etdDate = (ex.etd || '').slice(0, 10)
  const now = new Date().toISOString()

  // Same-day check: block if either source or target ETD is today/past
  const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  const todayET = new Date(nowET).toISOString().slice(0, 10)
  const sysEtdDate = (sys.etd || '').slice(0, 10)
  if ((sysEtdDate && sysEtdDate <= todayET) || (etdDate && etdDate <= todayET)) {
    return { ok: false, msg: `Same-day flight change ${sys.flightNumber} → ${rawFlight} — requires manual review` }
  }

  // V2: Use findOrCreateFlight (exact instance key, no fuzzy)
  const result = await findOrCreateFlight(rawFlight, ex.etd, ex.cutoff, ex.deliverTo, ex.dest, allFlights, dryRun, dryRunLog || [])
  if (result.action === 'blocked') {
    return { ok: false, msg: `Target flight ${rawFlight} is dispatched/closed — cannot move AWB` }
  }
  if (dryRun) {
    (dryRunLog || []).push({ type: 'would_move_real_to_real', awb: ex.awb1st, from: sys.flightNumber, to: rawFlight, flight_action: result.action })
    return { ok: true, msg: `[DRY-RUN] AWB ${ex.awb1st} would move ${sys.flightNumber} → ${rawFlight}` }
  }
  const targetFlight = result.flight
  if (!targetFlight) return { ok: false, msg: `Could not find or create flight ${rawFlight}` }

  // V2: Atomic move — single transaction for remove + add
  const clientId = sys.clientId
  const clientName = sys.clientName
  const awbToFind = sheetNormStr(ex.awb1st)
  const sourceBookingRef = db.collection('airfreight_bookings').doc(sys.bookingId)

  const existingSnap = await db.collection('airfreight_bookings')
    .where('flight_id', '==', targetFlight.id)
    .where('client_id', '==', clientId)
    .where('booking_type', '==', 'ecommerce')
    .get()
  const existingBooking = existingSnap.docs[0]
  let targetBookingRef = existingBooking ? existingBooking.ref : db.collection('airfreight_bookings').doc()
  const isNewBooking = !existingBooking

  const nonFlightDiffs = diffs.filter(d => d.field !== 'Vuelo')

  let moveResult = null
  await db.runTransaction(async (t) => {
    // All reads FIRST (Firestore requires reads before writes)
    const sourceSnap = await t.get(sourceBookingRef)
    const targetSnap = isNewBooking ? null : await t.get(targetBookingRef)

    if (!sourceSnap.exists) throw new Error('Source booking not found')
    const sourceData = sourceSnap.data()
    const sourceLines = [...(sourceData.awb_lines || [])]
    const idx = sourceLines.findIndex(l => sheetNormStr(l.awb_number || '') === awbToFind)
    if (idx < 0) { moveResult = 'already_moved'; return }

    const movedLine = { ...sourceLines[idx] }
    // Apply non-flight diffs (preserve all existing operational fields)
    for (const d of nonFlightDiffs) {
      if (d.field === 'PCS') movedLine.pieces = ex.pcs
      if (d.field === 'CW') movedLine.chargeable_weight = ex.cw
      if (d.field === 'ULD') movedLine.uld_type = ex.uld || null
      if (d.field === '2nd Leg') movedLine.awb_2nd_leg = ex.awb2nd || null
      if (d.field === 'Battery') movedLine.battery = ex.battery
      if (d.field === 'Pickup') movedLine.pickup_from = ex.pickupFrom || null
      if (d.field === 'Ready') movedLine.ready_for_pickup = ex.readyForPickup || null
      if (d.field === 'LFD') movedLine.last_day_free = ex.lastDayFree || null
      if (d.field === 'Docs/Drive') movedLine.docs_in_drive = ex.docsInDrive || false
    }
    sourceLines.splice(idx, 1)

    // Update source
    const updatedSource = { ...sourceData, awb_lines: sourceLines }
    t.update(sourceBookingRef, {
      awb_lines: sourceLines,
      pieces: sourceLines.reduce((s, l) => s + (l.pieces || 0), 0),
      awb_numbers_normalized: computeAwbNumbersNormalized(updatedSource),
    })

    // Write to target
    if (isNewBooking) {
      const newBookingData = {
        flight_id: targetFlight.id, flight_number: targetFlight.flight_number || null,
        airline: targetFlight.airline || '', booking_type: 'ecommerce',
        client_id: clientId, client_name: clientName,
        status: 'submitted', created_by: 'sheet_sync_agent', created_at: now,
        change_count: 0, modified_seen: true, change_log: [], documents: {},
        destination_id: normalizeDest(ex.dest) || '', awb_lines: [movedLine],
        pieces: movedLine.pieces || 0, hold: !!movedLine.hold, on_hand: !!movedLine.on_hand,
      }
      newBookingData.awb_numbers_normalized = computeAwbNumbersNormalized(newBookingData)
      t.set(targetBookingRef, newBookingData)
    } else {
      const targetData = targetSnap.data()
      const targetLines = [...(targetData.awb_lines || [])]
      if (targetLines.some(l => sheetNormStr(l.awb_number || '') === awbToFind)) return
      targetLines.push(movedLine)
      const updatedTarget = { ...targetData, awb_lines: targetLines }
      t.update(targetBookingRef, {
        awb_lines: targetLines,
        pieces: targetLines.reduce((s, l) => s + (l.pieces || 0), 0),
        awb_numbers_normalized: computeAwbNumbersNormalized(updatedTarget),
      })
    }
    moveResult = 'moved'
  })

  if (moveResult === 'already_moved') return { ok: true, msg: `AWB ${ex.awb1st} already moved (idempotent skip)` }

  // Reconcile doc_receptions
  await reconcileDocReceptionBookingId(ex.awb1st, ex.awb2nd, sys.bookingId, targetBookingRef.id)
  if (isNewBooking) {
    const awbNorms = [normalizeAwbForIndex(ex.awb1st), normalizeAwbForIndex(ex.awb2nd)].filter(Boolean)
    await reconcileOrphanDocReceptions(awbNorms, targetBookingRef.id, targetFlight.id)
  }

  return { ok: true, msg: `AWB ${ex.awb1st} moved from ${sys.flightNumber} → ${rawFlight}` }
}

async function applyDiffToSystem(ex, sys, diffs) {
  const hasFlightChange = diffs.some(d => d.field === 'Vuelo')
  if (hasFlightChange) {
    return { ok: false, msg: 'Flight change — requires manual review' }
  }

  // Protected fields: the agent must NOT overwrite these operational fields
  const PROTECTED_FIELDS = ['weight', 'warehouse_status', 'on_hand', 'dispatched', 'dispatched_at',
    'drop_off_time', 'screening_status', 'screening_date', 'screening_method', 'screening_result',
    'documents']

  const bookingRef = db.collection('airfreight_bookings').doc(sys.bookingId)
  await db.runTransaction(async (t) => {
    const snap = await t.get(bookingRef)
    if (!snap.exists) throw new Error(`Booking ${sys.bookingId.slice(0, 8)} not found`)
    const bData = snap.data()
    const lines = [...(bData.awb_lines || [])]
    if (sys.awbIndex >= lines.length) throw new Error('AWB index out of bounds')
    const line = { ...lines[sys.awbIndex] }

    for (const d of diffs) {
      if (d.field === 'PCS') line.pieces = ex.pcs
      if (d.field === 'CW') line.chargeable_weight = ex.cw
      if (d.field === 'ULD') line.uld_type = ex.uld || null
      if (d.field === '2nd Leg') line.awb_2nd_leg = ex.awb2nd || null
      if (d.field === 'Battery') line.battery = ex.battery
      if (d.field === 'Pickup') line.pickup_from = ex.pickupFrom || null
      if (d.field === 'Ready') line.ready_for_pickup = ex.readyForPickup || null
      if (d.field === 'LFD') line.last_day_free = ex.lastDayFree || null
      if (d.field === 'Docs/Drive') line.docs_in_drive = ex.docsInDrive || false
      if (d.field === 'Hold') {
        const holdBgLower = (ex.holdBg || '').toLowerCase().trim()
        const isNoHold = !holdBgLower || holdBgLower === 'no hold' || holdBgLower === 'no' || holdBgLower === 'n/a'
        const isPending = holdBgLower === 'pending' || holdBgLower === 'pendiente'
        line.hold = isNoHold ? false : isPending ? 'pending' : true
        if (line.hold === true) {
          line.holds = (ex.holds && ex.holds.length > 0) ? ex.holds : (ex.holdBg ? [{ bag: ex.holdBg, box: ex.holdBox || '' }] : [])
        } else if (isNoHold) {
          line.holds = []
        }
      }
      if (d.field === 'Holds') {
        // Update holds array with all holds from sheet (preserving existing photos)
        const existingHolds = line.holds || []
        const newHolds = (ex.holds || []).map(h => {
          // Preserve photo if existing hold has same bag
          const existing = existingHolds.find(eh => eh.bag === h.bag && eh.box === h.box)
          return existing ? { ...existing, bag: h.bag, box: h.box } : { bag: h.bag, box: h.box, photo: null }
        })
        line.holds = newHolds
        line.hold = newHolds.length > 0 ? true : line.hold
      }
    }

    lines[sys.awbIndex] = line
    const updatedData = { ...bData, awb_lines: lines }
    const updates = {
      awb_lines: lines,
      pieces: lines.reduce((s, l) => s + (l.pieces || 0), 0),
      awb_numbers_normalized: computeAwbNumbersNormalized(updatedData),
    }
    if (diffs.some(d => d.field === 'Dest') && ex.dest) updates.destination_id = normalizeDest(ex.dest)
    t.update(bookingRef, updates)
  })

  return { ok: true, msg: `AWB ${ex.awb1st} updated: ${diffs.map(d => d.field).join(', ')}` }
}

/**
 * A3-FIX: Reconcile doc_receptions and physical_pieces when 2nd leg changes.
 * Matches by 1st leg (stable identifier) within the booking, then updates
 * awb_2nd_leg on doc_receptions and awb_number on physical_pieces.
 * Only called for received (not built/dispatched) AWBs (R3+R5 compliance).
 */
async function reconcile2ndLegChange(bookingId, awb1st, old2ndLeg, new2ndLeg) {
  const norm1st = sheetNormStr(awb1st)
  const normOld2nd = sheetNormStr(old2ndLeg)
  if (!norm1st) return { ok: false, msg: 'No 1st leg to match' }

  let drUpdated = 0
  let ppUpdated = 0

  // Find doc_receptions by booking_id + awb_number (1st leg)
  const drSnap = await db.collection('airfreight_doc_receptions')
    .where('booking_id', '==', bookingId)
    .where('awb_number', '==', awb1st)
    .get()

  for (const drDoc of drSnap.docs) {
    // Update awb_2nd_leg on the doc_reception
    await drDoc.ref.update({ awb_2nd_leg: new2ndLeg || null })
    drUpdated++

    // Find physical_pieces linked to this doc_reception
    const ppSnap = await db.collection('airfreight_physical_pieces')
      .where('doc_reception_id', '==', drDoc.id)
      .get()

    for (const ppDoc of ppSnap.docs) {
      const ppData = ppDoc.data()
      const ppAwb = sheetNormStr(ppData.awb_number || '')
      // Update if piece has old 2nd leg or 1st leg as awb_number
      if (ppAwb === normOld2nd || ppAwb === norm1st) {
        await ppDoc.ref.update({ awb_number: new2ndLeg || awb1st })
        ppUpdated++
      }
    }
  }

  // Also search by old 2nd leg in case doc_reception.awb_number has 2nd leg instead of 1st
  if (normOld2nd && normOld2nd !== norm1st) {
    const drSnap2 = await db.collection('airfreight_doc_receptions')
      .where('booking_id', '==', bookingId)
      .where('awb_number', '==', old2ndLeg)
      .get()

    for (const drDoc of drSnap2.docs) {
      // Fix: set awb_number to 1st leg (stable) and awb_2nd_leg to new value
      await drDoc.ref.update({ awb_number: awb1st, awb_2nd_leg: new2ndLeg || null })
      drUpdated++

      const ppSnap = await db.collection('airfreight_physical_pieces')
        .where('doc_reception_id', '==', drDoc.id)
        .get()

      for (const ppDoc of ppSnap.docs) {
        await ppDoc.ref.update({ awb_number: new2ndLeg || awb1st })
        ppUpdated++
      }
    }
  }

  return { ok: true, msg: `Reconciled 2nd leg: ${drUpdated} doc_receptions, ${ppUpdated} physical_pieces` }
}

/**
 * Apply flight-level diffs (ETD, CutOff) to the flight document.
 * Uses updatedFlightsThisCycle Set to avoid redundant updates when multiple AWBs share a flight.
 */
async function applyFlightDiffs(ex, sys, diffs, updatedFlightsThisCycle) {
  const flightDiffs = diffs.filter(d => d.field === 'ETD' || d.field === 'CutOff')
  if (flightDiffs.length === 0) return { ok: true, msg: 'No flight diffs' }
  if (!sys.flightId) return { ok: false, msg: 'No flightId' }
  // Skip if flight already updated this cycle (multiple AWBs on same flight)
  if (updatedFlightsThisCycle.has(sys.flightId)) return { ok: true, msg: 'Flight already updated this cycle' }
  // H5: Check flight status — do not update dispatched/closed flights (check both fields + dispatched_at)
  const fStatus = (sys.flightStatus || '').toLowerCase()
  if (fStatus === 'dispatched' || fStatus === 'closed') {
    return { ok: false, msg: `Flight ${sys.flightNumber} is ${fStatus} — cannot update ETD/CutOff` }
  }
  if (sys.flightDispatchedAt || sys.dispatchedAt) {
    return { ok: false, msg: `Flight ${sys.flightNumber} has dispatched_at — cannot update ETD/CutOff` }
  }
  const flightUpdate = {}
  for (const d of flightDiffs) {
    if (d.field === 'ETD' && ex.etd) flightUpdate.flight_datetime = ex.etd
    if (d.field === 'CutOff' && ex.cutoff) flightUpdate.cutoff_datetime = ex.cutoff
  }
  if (Object.keys(flightUpdate).length === 0) return { ok: true, msg: 'No flight fields to update' }
  // V2: Update flight_instance_key when ETD changes
  if (flightUpdate.flight_datetime) {
    const newKey = buildInstanceKey(sys.flightNumber, flightUpdate.flight_datetime)
    if (newKey) flightUpdate.flight_instance_key = newKey
  }
  await db.collection('airfreight_flights').doc(sys.flightId).update(flightUpdate)
  updatedFlightsThisCycle.add(sys.flightId)
  return { ok: true, msg: `Flight ${sys.flightNumber} updated: ${Object.keys(flightUpdate).join(', ')}` }
}

/**
 * Check ETD vs CutOff consistency and generate alert if ETD < CutOff.
 */
async function checkEtdCutoffConsistency(ex, sys, config) {
  const etdDate = (ex.etd || sys.etd || '').slice(0, 10)
  const cutoffDate = (ex.cutoff || sys.cutoff || '').slice(0, 10)
  if (!etdDate || !cutoffDate) return // can't validate if either is missing
  if (etdDate < cutoffDate) {
    await db.collection('_sheet_sync_alerts').add({
      client_id: config.client_id, client_name: config.client_name,
      awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
      system_flight: sys.flightNumber,
      etd: ex.etd, diffs: [{ field: 'ETD vs CutOff', old_value: `CutOff: ${cutoffDate}`, new_value: `ETD: ${etdDate}` }],
      alert_type: 'etd_inconsistency',
      message: `ETD (${etdDate}) is before CutOff (${cutoffDate}) — impossible operationally`,
      status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
    })
  }
}

/**
 * Add a new AWB to the system (find or create flight + booking).
 */
async function applyNewToSystem(ex, clientId, clientName, allFlights, allBookings, dryRun, dryRunLog) {
  // Validate AWB format before creating
  const awb = (ex.awb1st || '').trim()
  if (!awb || !/\d{3}-\d+/.test(awb)) {
    return { ok: false, log: [`Invalid AWB: "${awb}" — skipped`] }
  }
  // CRITICAL: Check ALL client bookings for this AWB to prevent cross-booking duplicates
  const awbNormGlobal = sheetNormStr(awb)
  const awb2ndNorm = sheetNormStr(ex.awb2nd || '')
  for (const b of (allBookings || [])) {
    const exists = (b.awb_lines || []).some(l =>
      sheetNormStr(l.awb_number || '') === awbNormGlobal ||
      (awb2ndNorm && sheetNormStr(l.awb_2nd_leg || '') === awb2ndNorm)
    )
    if (exists) {
      return { ok: false, log: [`AWB ${awb} already exists in booking ${(b.id || '').slice(0, 8)} — skipped cross-booking duplicate`] }
    }
  }
  const now = new Date().toISOString()
  const rawFlight = (ex.flight || '').trim()
  const airline = ex.deliverTo || ''
  const log = []

  // V2: Use findOrCreateFlight (exact instance key, no fuzzy)
  const result = await findOrCreateFlight(rawFlight, ex.etd, ex.cutoff, airline, ex.dest, allFlights, dryRun, dryRunLog || [])
  if (result.action === 'blocked') {
    log.push(`Flight ${rawFlight} is dispatched/closed — cannot add AWB`)
    return { ok: false, log }
  }
  if (dryRun) {
    (dryRunLog || []).push({ type: 'would_add_new_awb', awb: ex.awb1st, flight: rawFlight, flight_action: result.action })
    return { ok: true, log: [`[DRY-RUN] AWB ${awb} would be added to ${rawFlight}`] }
  }
  const targetFlight = result.flight
  if (!targetFlight) {
    log.push(`Could not find or create flight ${rawFlight}`)
    return { ok: false, log }
  }
  if (result.action === 'created' || result.action === 'created_pending') {
    log.push(`Flight created: ${targetFlight.flight_number} (${(targetFlight.flight_datetime || '').slice(0, 10)})`)
  }

  const holdBgLower = (ex.holdBg || '').toLowerCase().trim()
  const isNoHold = !holdBgLower || holdBgLower === 'no hold' || holdBgLower === 'no' || holdBgLower === 'n/a'
  const isPendingHold = holdBgLower === 'pending' || holdBgLower === 'pendiente'
  const hasHold = !isNoHold && !isPendingHold && !!ex.holdBg

  const newLine = {
    awb_number: ex.awb1st, awb_2nd_leg: ex.awb2nd || null,
    pieces: ex.pcs, weight: 0, chargeable_weight: ex.cw,
    uld_type: ex.uld || null, pickup_from: ex.pickupFrom || null,
    ready_for_pickup: ex.readyForPickup || null,
    last_day_free: ex.lastDayFree || null,
    docs_in_drive: ex.docsInDrive || false,
    battery: ex.battery, ddgg: false,
    hold: hasHold ? true : isNoHold ? false : 'pending',
    on_hand: false,
    ...(hasHold ? { holds: (ex.holds && ex.holds.length > 0) ? ex.holds : [{ bag: ex.holdBg, box: ex.holdBox || '' }] } : {}),
  }

  // Find existing booking for this client+flight or create
  const existingSnap = await db.collection('airfreight_bookings')
    .where('flight_id', '==', targetFlight.id)
    .where('client_id', '==', clientId)
    .where('booking_type', '==', 'ecommerce')
    .get()
  const existingBooking = existingSnap.docs[0]

  if (existingBooking) {
    // Use transaction to prevent R-M-W conflicts when adding line
    let skippedDuplicate = false
    await db.runTransaction(async (t) => {
      const snap = await t.get(existingBooking.ref)
      const bData = snap.data()
      const existingLines = bData.awb_lines || []
      const awbNorm = sheetNormStr(ex.awb1st)
      const awb2Norm = sheetNormStr(ex.awb2nd || '')
      if (existingLines.some(l =>
        sheetNormStr(l.awb_number || '') === awbNorm ||
        (awb2Norm && sheetNormStr(l.awb_2nd_leg || '') === awb2Norm)
      )) {
        skippedDuplicate = true
        return
      }
      const lines = [...existingLines, newLine]
      const updatedData = { ...bData, awb_lines: lines, booking_type: bData.booking_type || 'ecommerce' }
      t.update(existingBooking.ref, {
        awb_lines: lines,
        pieces: lines.reduce((s, l) => s + (l.pieces || 0), 0),
        destination_id: normalizeDest(ex.dest) || bData.destination_id,
        awb_numbers_normalized: computeAwbNumbersNormalized(updatedData),
      })
    })
    if (skippedDuplicate) {
      log.push(`AWB ${ex.awb1st} already exists in booking — skipped duplicate`)
      return { ok: false, log }
    }
    // Orphan DR reconciliation: link doc_receptions when AWB added to existing booking
    const addedAwbNorms = [normalizeAwbForIndex(ex.awb1st), normalizeAwbForIndex(ex.awb2nd)].filter(Boolean)
    await reconcileOrphanDocReceptions(addedAwbNorms, existingBooking.id, targetFlight.id)
  } else {
    const newBookingData = {
      flight_id: targetFlight.id, flight_number: targetFlight.flight_number || null,
      airline: targetFlight.airline || '', booking_type: 'ecommerce',
      client_id: clientId, client_name: clientName,
      status: 'submitted', created_by: 'sheet_sync_agent', created_at: now,
      change_count: 0, modified_seen: true, change_log: [], documents: {},
      destination_id: normalizeDest(ex.dest) || '', awb_lines: [newLine],
      pieces: newLine.pieces, hold: !!newLine.hold, on_hand: false,
    }
    newBookingData.awb_numbers_normalized = computeAwbNumbersNormalized(newBookingData)
    const newBookingRef = await db.collection('airfreight_bookings').add(newBookingData)
    // Orphan DR reconciliation: link doc_receptions with booking_id=null
    await reconcileOrphanDocReceptions(newBookingData.awb_numbers_normalized, newBookingRef.id, targetFlight.id)
  }

  log.push(`AWB ${ex.awb1st} added to flight ${ex.flight}`)
  return { ok: true, log }
}

/**
 * Format an ISO datetime to a user-friendly date/time string for the sheet.
 * e.g. "2026-05-19T14:30:00.000Z" → "05-19 14:30" (ET timezone)
 */
function formatDateForSheet(isoStr) {
  if (!isoStr) return ''
  try {
    const d = new Date(isoStr)
    const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const mm = String(et.getMonth() + 1).padStart(2, '0')
    const dd = String(et.getDate()).padStart(2, '0')
    const hh = String(et.getHours()).padStart(2, '0')
    const min = String(et.getMinutes()).padStart(2, '0')
    return `${mm}-${dd} ${hh}:${min}`
  } catch { return isoStr.slice(0, 16).replace('T', ' ') }
}

/**
 * Write back ON-HAND DATE and DROPPED OFF DATE/TIME to the Google Sheet.
 * Only writes if the cell is currently empty. Never overwrites existing values.
 */
async function writeBackStatusToSheet(sheets, spreadsheetId, tabTitle, sheetRows, byAwb1, byAwb2, colMap, sheetId) {
  const onHandCol = colMap['on_hand_date']
  const droppedOffCol = colMap['dropped_off_date']

  // If neither column was found in the sheet, nothing to write
  if (onHandCol == null && droppedOffCol == null) {
    return { written: 0 }
  }

  const updates = []
  const formatRequests = [] // Sheets API batchUpdate requests for green background

  for (const row of sheetRows) {
    const key1 = sheetNormStr(row.awb1st)
    const key2 = sheetNormStr(row.awb2nd)
    const sys = byAwb1.get(key1) || byAwb2.get(key2)
    if (!sys) continue

    // Sheet row index is 0-based; Sheets API uses 1-based rows
    const sheetRow1 = row.sheetRowIdx + 1

    // ON-HAND DATE: write doc reception created_at (when cargo was documentally received)
    if (onHandCol != null && sys.docReceptionDate && !row.onHandDateCell) {
      const cellRef = `'${tabTitle}'!${colIndexToLetter(onHandCol)}${sheetRow1}`
      updates.push({ range: cellRef, values: [[formatDateForSheet(sys.docReceptionDate)]] })
      // Green background for On Hand Date cell
      if (sheetId != null) {
        formatRequests.push({
          repeatCell: {
            range: { sheetId, startRowIndex: row.sheetRowIdx, endRowIndex: row.sheetRowIdx + 1, startColumnIndex: onHandCol, endColumnIndex: onHandCol + 1 },
            cell: { userEnteredFormat: { backgroundColor: { red: 0.714, green: 0.843, blue: 0.659, alpha: 1 } } },
            fields: 'userEnteredFormat.backgroundColor',
          },
        })
      }
    }

    // DROPPED OFF DATE/TIME: write flight dispatched_at (when flight status changed Built → Dispatched)
    if (droppedOffCol != null && sys.flightDispatchedAt && !row.droppedOffDateCell) {
      const cellRef = `'${tabTitle}'!${colIndexToLetter(droppedOffCol)}${sheetRow1}`
      updates.push({ range: cellRef, values: [[formatDateForSheet(sys.flightDispatchedAt)]] })
    }
  }

  if (updates.length === 0) return { written: 0 }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates,
    },
  })

  // Apply green background formatting
  if (formatRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: formatRequests },
    })
  }

  return { written: updates.length }
}

/**
 * Core sync logic — called by both scheduled and manual triggers.
 */
async function runSheetSync(configOverride) {
  // V2: Load global config (dry-run toggle, circuit breaker thresholds)
  const globalConfigDoc = await db.collection('_sheet_sync_global').doc('config').get()
  const globalConfig = globalConfigDoc.exists ? globalConfigDoc.data() : {}
  const DRY_RUN = globalConfig.dry_run === true
  const CB_MAX_FLIGHTS = globalConfig.cb_max_flights || 10
  const CB_MAX_MOVES = globalConfig.cb_max_moves || 20
  const CB_MAX_GATE_BLOCKS = globalConfig.cb_max_gate_blocks || 10
  const dryRunLog = [] // V2: collects all dry-run decisions

  if (DRY_RUN) console.log('=== SYNC AGENT V2: DRY-RUN MODE ===')

  const configsSnap = configOverride
    ? { docs: [configOverride] }
    : await db.collection('_sheet_sync_configs').where('enabled', '==', true).get()

  if (configsSnap.docs.length === 0) {
    console.log('Sheet sync: no enabled configs found')
    return { totalChanges: 0, totalAlerts: 0 }
  }

  // Use Application Default Credentials (Cloud Functions service account)
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
  const sheets = google.sheets({ version: 'v4', auth })

  let totalChanges = 0
  let totalAlerts = 0

  for (const configDoc of configsSnap.docs) {
    const config = configDoc.data ? configDoc.data() : configDoc
    const configId = configDoc.id || config.client_id
    const runStart = Date.now()
    const runLog = { client_id: config.client_id, run_at: new Date().toISOString(), errors: [] }

    try {
      // 1. Get all sheet tab titles
      let allTabTitles = []
      try {
        const meta = await sheets.spreadsheets.get({
          spreadsheetId: config.spreadsheet_id,
          fields: 'sheets.properties.title,sheets.properties.sheetId',
        })
        allTabTitles = (meta.data.sheets || []).map(s => s.properties.title)
        var tabSheetIds = new Map()
        for (const s of (meta.data.sheets || [])) {
          tabSheetIds.set(s.properties.title, s.properties.sheetId)
        }
      } catch (err) {
        console.error(`Sheet sync [${config.client_name}]: Failed to get spreadsheet metadata:`, err.message)
        runLog.errors.push(`Spreadsheet metadata failed: ${err.message}`)
        runLog.status = 'error'
        runLog.duration_ms = Date.now() - runStart
        await db.collection('_sheet_sync_runs').add(runLog)
        continue
      }

      // 2. Find month tabs (current + previous if first 5 days)
      const tabsToRead = config.tab_name_override
        ? [{ tabTitle: config.tab_name_override, monthOffset: 0 }]
        : findMonthTabs(allTabTitles, config.tab_name_pattern || 'month_es')

      if (tabsToRead.length === 0) {
        console.log(`Sheet sync [${config.client_name}]: No matching tabs found. Available: ${allTabTitles.join(', ')}`)
        runLog.errors.push(`No matching tab. Available: ${allTabTitles.join(', ')}`)
        runLog.status = 'error'
        runLog.duration_ms = Date.now() - runStart
        await db.collection('_sheet_sync_runs').add(runLog)
        continue
      }

      // 3. Read and merge rows from all matching tabs
      let sheetRows = []
      const tabNames = []
      const tabParseResults = [] // { tabTitle, colMap, rows } per tab for write-back
      for (const { tabTitle } of tabsToRead) {
        try {
          const resp = await sheets.spreadsheets.values.get({
            spreadsheetId: config.spreadsheet_id,
            range: `'${tabTitle}'`,
            valueRenderOption: 'UNFORMATTED_VALUE',
          })
          const parseResult = parseSheetRows(resp.data.values || [])
          // DIAG: Log detected column mapping for debugging header detection issues
          console.log(`Sheet sync [${config.client_name}] tab "${tabTitle}": colMap = ${JSON.stringify(parseResult.colMap)}, headerRow = ${parseResult.headerRowIdx}, dataRows = ${parseResult.rows.length}`)
          sheetRows = sheetRows.concat(parseResult.rows)
          tabNames.push(tabTitle)
          tabParseResults.push({ tabTitle, colMap: parseResult.colMap, rows: parseResult.rows, sheetId: (tabSheetIds && tabSheetIds.get(tabTitle)) || 0 })
        } catch (err) {
          console.error(`Sheet sync [${config.client_name}]: Failed to read tab "${tabTitle}":`, err.message)
          runLog.errors.push(`Tab "${tabTitle}" read failed: ${err.message}`)
        }
      }

      // Deduplicate by AWB (keep last occurrence — current month wins over previous)
      const deduped = new Map()
      for (const row of sheetRows) {
        const key = sheetNormStr(row.awb1st) || sheetNormStr(row.awb2nd)
        if (key) deduped.set(key, row)
      }
      sheetRows = [...deduped.values()]
      const tabName = tabNames.join(' + ')

      if (sheetRows.length === 0) {
        console.log(`Sheet sync [${config.client_name}]: No data rows found in tabs: ${tabName}`)
        runLog.rows_checked = 0; runLog.status = 'success'; runLog.duration_ms = Date.now() - runStart
        await db.collection('_sheet_sync_runs').add(runLog)
        continue
      }

      // 4. Compute hashes and compare to snapshot
      // V2: Persistent snapshot (not month-based) — survives month transitions
      const monthKey = new Date().toISOString().slice(0, 7) // for logging only
      const snapshotId = `${config.client_id}_sync`
      const snapshotRef = db.collection('_sheet_sync_snapshots').doc(snapshotId)
      const snapshotDoc = await snapshotRef.get()
      const prevHashes = snapshotDoc.exists ? (snapshotDoc.data().row_hashes || {}) : {}

      const currentHashes = {}
      const changedRows = []
      const newRows = []
      // Incremental checkpoint: update a single AWB hash after successful processing
      const checkpointedKeys = new Set()
      async function checkpoint(awbKey) {
        if (!awbKey || checkpointedKeys.has(awbKey)) return
        checkpointedKeys.add(awbKey)
        const hash = currentHashes[awbKey]
        if (hash) {
          await snapshotRef.set({ row_hashes: { [awbKey]: hash } }, { merge: true })
        }
      }

      for (const row of sheetRows) {
        const key = sheetNormStr(row.awb1st) || sheetNormStr(row.awb2nd)
        if (!key) continue
        const hash = rowHash(row)
        currentHashes[key] = hash
        if (!prevHashes[key]) {
          newRows.push(row)
        } else if (prevHashes[key] !== hash) {
          changedRows.push(row)
        }
      }

      // Detect removed rows (in previous snapshot but not in current sheet)
      const removedKeys = Object.keys(prevHashes).filter(k => !(k in currentHashes))

      const hasChanges = changedRows.length > 0 || newRows.length > 0 || removedKeys.length > 0

      if (!hasChanges) {
        // Update snapshot timestamp, no changes
        await snapshotRef.set({
          client_id: config.client_id, month_key: monthKey, tab_name: tabName,
          row_hashes: currentHashes, row_count: sheetRows.length,
          last_checked_at: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true })
        runLog.rows_checked = sheetRows.length; runLog.changes_detected = 0
        runLog.status = 'success'; runLog.duration_ms = Date.now() - runStart
        await db.collection('_sheet_sync_runs').add(runLog)
        continue
      }

      // 5. Load system data for comparison
      const bookingsSnap = await db.collection('airfreight_bookings')
        .where('client_id', '==', config.client_id)
        .where('booking_type', '==', 'ecommerce')
        .get()
      const bookings = bookingsSnap.docs.map(d => ({ id: d.id, ...d.data() }))

      // V2 (F6): Load flights cross-client by flight_number (not just by booking refs)
      const flightIds = new Set(bookings.map(b => b.flight_id).filter(Boolean))
      const flightMap = new Map()
      const allFlights = []
      const allFlightsById = new Set()

      // 5a. Load flights referenced by this client's bookings (needed for buildSystemMaps)
      const flightIdArr = [...flightIds]
      for (let i = 0; i < flightIdArr.length; i += 30) {
        const batch = flightIdArr.slice(i, i + 30)
        const fSnap = await db.collection('airfreight_flights').where(admin.firestore.FieldPath.documentId(), 'in', batch).get()
        fSnap.docs.forEach(d => {
          const f = { id: d.id, ...d.data() }
          flightMap.set(d.id, f)
          allFlights.push(f)
          allFlightsById.add(d.id)
        })
      }

      // 5b. Load ALL flights matching flight numbers in the sheet (cross-client dedup)
      const sheetFlightNumbers = new Set()
      for (const row of sheetRows) {
        const fn = normalizeFlightNumber(row.flight)
        if (fn && !/^(PENDING|TBD|TBA|N\/A)$/i.test(fn)) sheetFlightNumbers.add(fn)
      }
      const fnArr = [...sheetFlightNumbers]
      for (let i = 0; i < fnArr.length; i += 30) {
        const batch = fnArr.slice(i, i + 30)
        const fSnap = await db.collection('airfreight_flights').where('flight_number', 'in', batch).get()
        fSnap.docs.forEach(d => {
          if (allFlightsById.has(d.id)) return // already loaded
          const f = { id: d.id, ...d.data() }
          allFlights.push(f)
          allFlightsById.add(d.id)
        })
      }
      // Also load PENDING flights
      const pendingSnap = await db.collection('airfreight_flights').where('flight_number', '==', 'PENDING').get()
      pendingSnap.docs.forEach(d => {
        if (allFlightsById.has(d.id)) return
        const f = { id: d.id, ...d.data() }
        allFlights.push(f)
        allFlightsById.add(d.id)
      })

      // 5b. Load doc_receptions — detect received AWBs (have DocReception) and built AWBs (pieces in ULDs)
      const builtAwbs = new Set() // normalized AWB numbers that have pieces in ULDs
      const receivedAwbs = new Set() // normalized AWB numbers that have any DocReception (doc or physical reception started)
      const docReceptionDates = new Map() // normalized AWB → earliest doc reception created_at (for ON-HAND DATE write-back)
      const bookingIds = bookings.map(b => b.id)
      for (let i = 0; i < bookingIds.length; i += 30) {
        const chunk = bookingIds.slice(i, i + 30)
        const drSnap = await db.collection('airfreight_doc_receptions')
          .where('booking_id', 'in', chunk)
          .get()
        for (const drDoc of drSnap.docs) {
          const dr = drDoc.data()
          // A1-FIX: Add BOTH 1st leg (stable) and 2nd leg to receivedAwbs/builtAwbs sets
          // so that received/built flags survive 2nd leg changes (R2 compliance)
          const awb1 = sheetNormStr(dr.awb_number)       // 1st leg — stable identifier
          const awb2 = sheetNormStr(dr.awb_2nd_leg)       // 2nd leg — may change
          const awbKeys = [awb1, awb2].filter(Boolean)
          for (const awb of awbKeys) {
            receivedAwbs.add(awb)
            // Track earliest doc reception date per AWB
            const drCreated = dr.created_at ? (dr.created_at.toDate ? dr.created_at.toDate().toISOString() : dr.created_at) : null
            if (drCreated && (!docReceptionDates.has(awb) || drCreated < docReceptionDates.get(awb))) {
              docReceptionDates.set(awb, drCreated)
            }
          }
          // Only check for built pieces on doc_receptions with physical reception
          if (dr.status === 'in_physical' || dr.status === 'complete') {
            const ppSnap = await db.collection('airfreight_physical_pieces')
              .where('doc_reception_id', '==', drDoc.id)
              .where('uld_id', '!=', null)
              .limit(1)
              .get()
            if (!ppSnap.empty) {
              for (const awb of awbKeys) builtAwbs.add(awb)
            }
          }
        }
      }

      const { byAwb1, byAwb2 } = buildSystemMaps(bookings, flightMap, builtAwbs, receivedAwbs, docReceptionDates)

      // 6. Determine today in ET timezone for same-day logic
      // RULE: Never auto-apply changes to flights with ETD = today (either system or Excel ETD).
      // Today's operations are manual only.
      const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
      const todayET = new Date(nowET).toISOString().slice(0, 10)
      function isTodayOrPast(sysEtd, exEtd) {
        const d1 = (sysEtd || '').slice(0, 10)
        const d2 = (exEtd || '').slice(0, 10)
        return (d1 && d1 <= todayET) || (d2 && d2 <= todayET)
      }

      let changesApplied = 0
      let alertsGenerated = 0
      let pendingTransitions = 0
      const MAX_PENDING_TRANSITIONS = 10
      // Track AWBs processed in this cycle to prevent intra-cycle duplicates
      const processedAwbsThisCycle = new Set()
      // Track flights updated this cycle to prevent redundant updates (multiple AWBs per flight)
      const updatedFlightsThisCycle = new Set()

      // V2: Circuit breaker counters
      let cbFlightsCreated = 0
      let cbAwbsMoved = 0
      let cbGateBlocks = 0
      let circuitBroken = false
      function checkCircuitBreaker(action) {
        if (circuitBroken) return true
        if (action === 'flight_created') cbFlightsCreated++
        if (action === 'awb_moved') cbAwbsMoved++
        if (action === 'gate_blocked') cbGateBlocks++
        if (cbFlightsCreated > CB_MAX_FLIGHTS || cbAwbsMoved > CB_MAX_MOVES || cbGateBlocks > CB_MAX_GATE_BLOCKS) {
          circuitBroken = true
          console.error(`CIRCUIT BREAKER ACTIVATED: flights=${cbFlightsCreated}, moves=${cbAwbsMoved}, gates=${cbGateBlocks}`)
          db.collection('_sheet_sync_alerts').add({
            alert_type: 'circuit_breaker', status: 'critical',
            client_id: config.client_id, client_name: config.client_name,
            message: `Circuit breaker: flights_created=${cbFlightsCreated}, awbs_moved=${cbAwbsMoved}, gate_blocks=${cbGateBlocks}`,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
          })
          return true
        }
        return false
      }

      // Process changed rows (diffs)
      for (const ex of changedRows) {
        const key1 = sheetNormStr(ex.awb1st)
        const key2 = sheetNormStr(ex.awb2nd)
        if (key1 && processedAwbsThisCycle.has(key1)) continue
        if (key2 && processedAwbsThisCycle.has(key2)) continue
        const sys = byAwb1.get(key1) || byAwb2.get(key2)

        if (!sys) {
          // Row changed in sheet but not found in system — treat as new
          newRows.push(ex)
          continue
        }

        const diffs = computeDiffs(ex, sys)
        if (diffs.length === 0) {
          // ENRICH-FIX: If deliverTo changed (hash changed but no operational diffs),
          // enrich flight airline if still Unknown. Safe: only updates flight doc, no AWB changes.
          if (!DRY_RUN && !circuitBroken && ex.deliverTo && ex.deliverTo.trim().length >= 2 &&
              /[a-z]/i.test(ex.deliverTo) && (sys.airline === 'Unknown' || !sys.airline) &&
              sys.flightId && !isFlightBlocked({ flight_status: sys.flightStatus })) {
            await db.collection('airfreight_flights').doc(sys.flightId).update({ airline: ex.deliverTo.trim() })
          }
          if (key1) processedAwbsThisCycle.add(key1); if (key2) processedAwbsThisCycle.add(key2); await checkpoint(key1); continue
        }

        // Check if built (pieces distributed in ULDs) — block all changes
        if (sys.built) {
          await db.collection('_sheet_sync_alerts').add({
            client_id: config.client_id, client_name: config.client_name,
            awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
            system_flight: sys.flightNumber,
            etd: ex.etd, diffs, alert_type: 'built_change',
            message: `AWB already built on flight ${sys.flightNumber} — cannot auto-update`,
            status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
          })
          alertsGenerated++
          await checkpoint(key1)
          continue
        }

        // Check if dispatched
        if (sys.dispatched) {
          await db.collection('_sheet_sync_alerts').add({
            client_id: config.client_id, client_name: config.client_name,
            awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
            system_flight: sys.flightNumber,
            etd: ex.etd, diffs, alert_type: 'dispatched_change',
            status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
          })
          alertsGenerated++
          await checkpoint(key1)
          continue
        }

        // PENDING → real flight transition: auto-move AWB to correct flight
        const hasPendingFlightChange = diffs.some(d => d.field === 'Vuelo') && /^PENDING/i.test(sys.flightNumber || '')
        if (hasPendingFlightChange) {
          if (circuitBroken) continue // V2: circuit breaker
          if (pendingTransitions >= MAX_PENDING_TRANSITIONS) continue // batching: defer to next cycle
          const result = await applyPendingToReal(ex, sys, diffs, allFlights, DRY_RUN, dryRunLog)
          if (result.ok) {
            changesApplied++
            pendingTransitions++
            checkCircuitBreaker('awb_moved')
            if (!DRY_RUN) await db.collection('_sheet_sync_alerts').add({
              client_id: config.client_id, client_name: config.client_name,
              awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
              system_flight: 'PENDING',
              etd: ex.etd, diffs, alert_type: 'pending_resolved',
              message: result.msg,
              status: 'applied', created_at: admin.firestore.FieldValue.serverTimestamp(),
            })
            await checkpoint(key1)
          } else {
            await db.collection('_sheet_sync_alerts').add({
              client_id: config.client_id, client_name: config.client_name,
              awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
              system_flight: 'PENDING',
              etd: ex.etd, diffs, alert_type: 'needs_review',
              message: result.msg,
              status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
            })
            alertsGenerated++
          }
          continue
        }

        // A4-FIX: Real → real flight change — auto-move AWB with all states (R4 compliance)
        const hasRealFlightChange = diffs.some(d => d.field === 'Vuelo') && !/^PENDING/i.test(sys.flightNumber || '')
        if (hasRealFlightChange) {
          if (circuitBroken) continue // V2: circuit breaker
          const result = await applyRealToReal(ex, sys, diffs, allFlights, DRY_RUN, dryRunLog)
          if (result.ok) {
            changesApplied++
            await db.collection('_sheet_sync_alerts').add({
              client_id: config.client_id, client_name: config.client_name,
              awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
              system_flight: sys.flightNumber,
              etd: ex.etd, diffs, alert_type: 'flight_moved',
              message: result.msg,
              status: 'applied', created_at: admin.firestore.FieldValue.serverTimestamp(),
            })
          } else {
            await db.collection('_sheet_sync_alerts').add({
              client_id: config.client_id, client_name: config.client_name,
              awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
              system_flight: sys.flightNumber,
              etd: ex.etd, diffs, alert_type: 'needs_review',
              message: result.msg,
              status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
            })
            alertsGenerated++
          }
          await checkpoint(key1)
          continue
        }

        // Check if AWB has doc/physical reception — protect critical fields
        // A2-FIX: '2nd Leg' moved to RECONCILABLE — applied on received (not built) AWBs,
        // triggers doc_reception/physical_pieces reconciliation (R3 compliance)
        const CRITICAL_FIELDS = ['Vuelo', 'PCS', 'CW', 'Dest']
        const RECONCILABLE_FIELDS = ['2nd Leg']
        const SAFE_FIELDS = ['Hold', 'Holds', 'Battery', 'ULD', 'Docs/Drive', 'Pickup', 'Ready', 'LFD']
        const FLIGHT_FIELDS = ['ETD', 'CutOff'] // Safe for flight — update flight doc, not AWB line
        if (sys.received) {
          // Built/dispatched AWBs: RECONCILABLE behaves as CRITICAL (R5)
          const effectiveCritical = sys.built || sys.dispatched
            ? [...CRITICAL_FIELDS, ...RECONCILABLE_FIELDS]
            : CRITICAL_FIELDS
          const effectiveSafe = sys.built || sys.dispatched
            ? SAFE_FIELDS
            : [...SAFE_FIELDS, ...RECONCILABLE_FIELDS]

          const criticalDiffs = diffs.filter(d => effectiveCritical.includes(d.field))
          const safeDiffs = diffs.filter(d => effectiveSafe.includes(d.field))
          const flightDiffs = diffs.filter(d => FLIGHT_FIELDS.includes(d.field))

          if (criticalDiffs.length > 0) {
            await db.collection('_sheet_sync_alerts').add({
              client_id: config.client_id, client_name: config.client_name,
              awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
              system_flight: sys.flightNumber,
              etd: ex.etd, diffs: criticalDiffs, alert_type: 'received_change',
              message: `AWB has doc/physical reception on flight ${sys.flightNumber} — critical changes require manual review: ${criticalDiffs.map(d => d.field).join(', ')}`,
              status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
            })
            alertsGenerated++
          }

          if (safeDiffs.length > 0) {
            const result = await applyDiffToSystem(ex, sys, safeDiffs)
            if (result.ok) {
              changesApplied++
              // A3-FIX: If 2nd Leg changed on a received AWB, reconcile doc_receptions + physical_pieces
              const has2ndLegChange = safeDiffs.some(d => d.field === '2nd Leg')
              if (has2ndLegChange) {
                const reconResult = await reconcile2ndLegChange(sys.bookingId, ex.awb1st, sys.awb2nd, ex.awb2nd)
                await db.collection('_sheet_sync_alerts').add({
                  client_id: config.client_id, client_name: config.client_name,
                  awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                  system_flight: sys.flightNumber,
                  etd: ex.etd, diffs: safeDiffs, alert_type: 'reconciled',
                  message: `2nd Leg changed on received AWB: ${sys.awb2nd} → ${ex.awb2nd}. ${reconResult.msg}`,
                  status: 'applied', created_at: admin.firestore.FieldValue.serverTimestamp(),
                })
              } else {
                await db.collection('_sheet_sync_alerts').add({
                  client_id: config.client_id, client_name: config.client_name,
                  awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                  system_flight: sys.flightNumber,
                  etd: ex.etd, diffs: safeDiffs, alert_type: 'applied',
                  status: 'applied', created_at: admin.firestore.FieldValue.serverTimestamp(),
                })
              }
            }
          }
          // Flight diffs (ETD/CutOff) — safe to apply even on received AWBs
          if (flightDiffs.length > 0) {
            await applyFlightDiffs(ex, sys, flightDiffs, updatedFlightsThisCycle)
            await checkEtdCutoffConsistency(ex, sys, config)
          }
          await checkpoint(key1)
          continue
        }

        // Determine operation date (ETD) — check both system and Excel ETD
        const isSameDay = isTodayOrPast(sys.etd, ex.etd)

        if (isSameDay) {
          // Holds and flight diffs (ETD/CutOff) are always applied, even on same-day flights
          const holdDiffs = diffs.filter(d => d.field === 'Hold' || d.field === 'Holds')
          const flightDiffs = diffs.filter(d => FLIGHT_FIELDS.includes(d.field))
          const otherDiffs = diffs.filter(d => d.field !== 'Hold' && d.field !== 'Holds' && !FLIGHT_FIELDS.includes(d.field))
          if (holdDiffs.length > 0) {
            const result = await applyDiffToSystem(ex, sys, holdDiffs)
            if (result.ok) changesApplied++
          }
          if (flightDiffs.length > 0) {
            await applyFlightDiffs(ex, sys, flightDiffs, updatedFlightsThisCycle)
            await checkEtdCutoffConsistency(ex, sys, config)
          }
          if (otherDiffs.length > 0) {
            await db.collection('_sheet_sync_alerts').add({
              client_id: config.client_id, client_name: config.client_name,
              awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
              system_flight: sys.flightNumber,
              etd: ex.etd, diffs: otherDiffs, alert_type: 'same_day_change',
              status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
            })
            alertsGenerated++
          }
          await checkpoint(key1)
        } else {
          // Separate flight diffs from AWB diffs
          const flightDiffs = diffs.filter(d => FLIGHT_FIELDS.includes(d.field))
          const awbDiffs = diffs.filter(d => !FLIGHT_FIELDS.includes(d.field))
          // Apply flight diffs (ETD/CutOff) to flight document
          if (flightDiffs.length > 0) {
            await applyFlightDiffs(ex, sys, flightDiffs, updatedFlightsThisCycle)
            await checkEtdCutoffConsistency(ex, sys, config)
          }
          // Apply AWB diffs to booking
          if (awbDiffs.length > 0) {
            const result = await applyDiffToSystem(ex, sys, awbDiffs)
            if (result.ok) {
              changesApplied++
              await db.collection('_sheet_sync_alerts').add({
                client_id: config.client_id, client_name: config.client_name,
                awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                system_flight: sys.flightNumber,
                etd: ex.etd, diffs: awbDiffs, alert_type: 'applied',
                status: 'applied', created_at: admin.firestore.FieldValue.serverTimestamp(),
              })
            } else {
              await db.collection('_sheet_sync_alerts').add({
                client_id: config.client_id, client_name: config.client_name,
                awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                system_flight: sys.flightNumber,
                etd: ex.etd, diffs: awbDiffs, alert_type: 'needs_review',
                message: result.msg,
                status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
              })
              alertsGenerated++
            }
          } else if (flightDiffs.length > 0) {
            // Only flight diffs, no AWB diffs — still count as change applied
            changesApplied++
          }
          await checkpoint(key1)
        }
        // ENRICH-FIX: After applying diffs, enrich flight airline if still Unknown
        if (!DRY_RUN && !circuitBroken && ex.deliverTo && ex.deliverTo.trim().length >= 2 &&
            /[a-z]/i.test(ex.deliverTo) && (sys.airline === 'Unknown' || !sys.airline) &&
            sys.flightId && !isFlightBlocked({ flight_status: sys.flightStatus })) {
          await db.collection('airfreight_flights').doc(sys.flightId).update({ airline: ex.deliverTo.trim() })
        }
        // Mark AWB as processed in this cycle
        if (key1) processedAwbsThisCycle.add(key1)
        if (key2) processedAwbsThisCycle.add(key2)
      }

      // Process new rows
      for (const ex of newRows) {
        // Skip invalid/total rows: AWB must look like a real AWB (contain a dash and digits)
        const awbCheck = (ex.awb1st || '').trim()
        if (!awbCheck || !/\d{3}-\d+/.test(awbCheck)) {
          continue // Skip totals, formulas, empty AWBs
        }

        // F5: Relaxed validation — allow rows with logistics data (dest, pickup, LFD)
        // even without flight/ETD/2nd leg. These get created as PENDING and updated later.
        const hasFlightNum = (ex.flight || '').trim().length > 0
        const hasEtd = (ex.etd || '').trim().length > 0
        const has2ndLeg = (ex.awb2nd || '').trim().length > 0
        const hasDest = (ex.dest || '').trim().length > 0
        const hasPickupData = (ex.pickupFrom || '').trim().length > 0
          || (ex.readyForPickup || '').trim().length > 0
          || (ex.lastDayFree || '').trim().length > 0
        if (!hasFlightNum && !hasEtd && !has2ndLeg && !hasDest && !hasPickupData) {
          // Don't save hash for truly incomplete rows — allows re-evaluation when data appears
          const skipKey = sheetNormStr(ex.awb1st) || sheetNormStr(ex.awb2nd)
          if (skipKey) delete currentHashes[skipKey]
          continue
        }

        // CRITICAL: Check if this AWB already exists in the system to avoid duplicates
        const key1 = sheetNormStr(ex.awb1st)
        const key2 = sheetNormStr(ex.awb2nd)
        // Skip if already processed in this cycle (prevents intra-cycle duplicates)
        if (key1 && processedAwbsThisCycle.has(key1)) continue
        if (key2 && processedAwbsThisCycle.has(key2)) continue
        const existingSys = byAwb1.get(key1) || byAwb2.get(key2)
        if (existingSys) {
          // AWB already in system — compare and apply diffs instead of adding new
          // Block if dispatched
          if (existingSys.dispatched) {
            const diffs = computeDiffs(ex, existingSys)
            if (diffs.length > 0) {
              await db.collection('_sheet_sync_alerts').add({
                client_id: config.client_id, client_name: config.client_name,
                awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                system_flight: existingSys.flightNumber,
                etd: ex.etd, diffs, alert_type: 'dispatched_change',
                status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
              })
              alertsGenerated++
            }
            await checkpoint(key1)
            continue
          }
          // Block if built (pieces in ULDs)
          if (existingSys.built) {
            const diffs = computeDiffs(ex, existingSys)
            if (diffs.length > 0) {
              await db.collection('_sheet_sync_alerts').add({
                client_id: config.client_id, client_name: config.client_name,
                awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                system_flight: existingSys.flightNumber,
                etd: ex.etd, diffs, alert_type: 'built_change',
                message: `AWB already built on flight ${existingSys.flightNumber} — cannot auto-update`,
                status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
              })
              alertsGenerated++
            }
            await checkpoint(key1)
            continue
          }
          const diffs = computeDiffs(ex, existingSys)
          if (diffs.length === 0) { await checkpoint(key1); continue }

          // PENDING → real flight transition
          const hasPendingChange = diffs.some(d => d.field === 'Vuelo') && /^PENDING/i.test(existingSys.flightNumber || '')
          if (hasPendingChange) {
            if (pendingTransitions >= MAX_PENDING_TRANSITIONS) { await checkpoint(key1); continue }
            const result = await applyPendingToReal(ex, existingSys, diffs, allFlights, DRY_RUN, dryRunLog)
            if (result.ok) {
              changesApplied++
              pendingTransitions++
              await db.collection('_sheet_sync_alerts').add({
                client_id: config.client_id, client_name: config.client_name,
                awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                system_flight: 'PENDING',
                etd: ex.etd, diffs, alert_type: 'pending_resolved',
                message: result.msg,
                status: 'applied', created_at: admin.firestore.FieldValue.serverTimestamp(),
              })
              await checkpoint(key1)
            } else {
              await db.collection('_sheet_sync_alerts').add({
                client_id: config.client_id, client_name: config.client_name,
                awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                system_flight: 'PENDING',
                etd: ex.etd, diffs, alert_type: 'needs_review',
                message: result.msg,
                status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
              })
              alertsGenerated++
            }
            continue
          }

          // A4-FIX: Real → real flight change — auto-move AWB with all states (R4 compliance)
          const hasRealFlightChangeNR = diffs.some(d => d.field === 'Vuelo') && !/^PENDING/i.test(existingSys.flightNumber || '')
          if (hasRealFlightChangeNR) {
            const result = await applyRealToReal(ex, existingSys, diffs, allFlights, DRY_RUN, dryRunLog)
            if (result.ok) {
              changesApplied++
              await db.collection('_sheet_sync_alerts').add({
                client_id: config.client_id, client_name: config.client_name,
                awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                system_flight: existingSys.flightNumber,
                etd: ex.etd, diffs, alert_type: 'flight_moved',
                message: result.msg,
                status: 'applied', created_at: admin.firestore.FieldValue.serverTimestamp(),
              })
            } else {
              await db.collection('_sheet_sync_alerts').add({
                client_id: config.client_id, client_name: config.client_name,
                awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                system_flight: existingSys.flightNumber,
                etd: ex.etd, diffs, alert_type: 'needs_review',
                message: result.msg,
                status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
              })
              alertsGenerated++
            }
            await checkpoint(key1)
            continue
          }

          // Check if received — protect critical fields, allow safe + flight fields
          // A2-FIX: '2nd Leg' is RECONCILABLE — applied on received (not built) AWBs (R3 compliance)
          if (existingSys.received) {
            const CRITICAL_FIELDS_NR = ['Vuelo', 'PCS', 'CW', 'Dest']
            const RECONCILABLE_FIELDS_NR = ['2nd Leg']
            const SAFE_FIELDS_NR = ['Hold', 'Holds', 'Battery', 'Docs/Drive', 'Pickup', 'Ready', 'LFD', 'ULD']
            const FLIGHT_FIELDS_NR = ['ETD', 'CutOff']
            // Built/dispatched AWBs: RECONCILABLE behaves as CRITICAL (R5)
            const effectiveCritical = existingSys.built || existingSys.dispatched
              ? [...CRITICAL_FIELDS_NR, ...RECONCILABLE_FIELDS_NR]
              : CRITICAL_FIELDS_NR
            const effectiveSafe = existingSys.built || existingSys.dispatched
              ? SAFE_FIELDS_NR
              : [...SAFE_FIELDS_NR, ...RECONCILABLE_FIELDS_NR]

            const criticalDiffs = diffs.filter(d => effectiveCritical.includes(d.field))
            const safeDiffs = diffs.filter(d => effectiveSafe.includes(d.field))
            const flightDiffs = diffs.filter(d => FLIGHT_FIELDS_NR.includes(d.field))
            if (criticalDiffs.length > 0) {
              await db.collection('_sheet_sync_alerts').add({
                client_id: config.client_id, client_name: config.client_name,
                awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                system_flight: existingSys.flightNumber,
                etd: ex.etd, diffs: criticalDiffs, alert_type: 'received_change',
                message: `AWB has doc/physical reception on flight ${existingSys.flightNumber} — critical changes require manual review: ${criticalDiffs.map(d => d.field).join(', ')}`,
                status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
              })
              alertsGenerated++
            }
            if (safeDiffs.length > 0) {
              const result = await applyDiffToSystem(ex, existingSys, safeDiffs)
              if (result.ok) {
                changesApplied++
                // A3-FIX: If 2nd Leg changed on a received AWB, reconcile doc_receptions + physical_pieces
                const has2ndLegChange = safeDiffs.some(d => d.field === '2nd Leg')
                if (has2ndLegChange) {
                  const reconResult = await reconcile2ndLegChange(existingSys.bookingId, ex.awb1st, existingSys.awb2nd, ex.awb2nd)
                  await db.collection('_sheet_sync_alerts').add({
                    client_id: config.client_id, client_name: config.client_name,
                    awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                    system_flight: existingSys.flightNumber,
                    etd: ex.etd, diffs: safeDiffs, alert_type: 'reconciled',
                    message: `2nd Leg changed on received AWB: ${existingSys.awb2nd} → ${ex.awb2nd}. ${reconResult.msg}`,
                    status: 'applied', created_at: admin.firestore.FieldValue.serverTimestamp(),
                  })
                } else {
                  await db.collection('_sheet_sync_alerts').add({
                    client_id: config.client_id, client_name: config.client_name,
                    awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                    system_flight: existingSys.flightNumber,
                    etd: ex.etd, diffs: safeDiffs, alert_type: 'applied',
                    status: 'applied', created_at: admin.firestore.FieldValue.serverTimestamp(),
                  })
                }
              }
            }
            if (flightDiffs.length > 0) {
              await applyFlightDiffs(ex, existingSys, flightDiffs, updatedFlightsThisCycle)
              await checkEtdCutoffConsistency(ex, existingSys, config)
            }
            await checkpoint(key1)
            continue
          }

          const isSameDay = isTodayOrPast(existingSys.etd, ex.etd)
          const FLIGHT_FIELDS_NR = ['ETD', 'CutOff']
          if (isSameDay) {
            // Holds and flight diffs always applied on same-day
            const holdDiffs = diffs.filter(d => d.field === 'Hold' || d.field === 'Holds')
            const flightDiffs = diffs.filter(d => FLIGHT_FIELDS_NR.includes(d.field))
            const otherDiffs = diffs.filter(d => d.field !== 'Hold' && d.field !== 'Holds' && !FLIGHT_FIELDS_NR.includes(d.field))
            if (holdDiffs.length > 0) {
              const result = await applyDiffToSystem(ex, existingSys, holdDiffs)
              if (result.ok) changesApplied++
            }
            if (flightDiffs.length > 0) {
              await applyFlightDiffs(ex, existingSys, flightDiffs, updatedFlightsThisCycle)
              await checkEtdCutoffConsistency(ex, existingSys, config)
            }
            if (otherDiffs.length > 0) {
              await db.collection('_sheet_sync_alerts').add({
                client_id: config.client_id, client_name: config.client_name,
                awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                system_flight: existingSys.flightNumber,
                etd: ex.etd, diffs: otherDiffs, alert_type: 'same_day_change',
                status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
              })
              alertsGenerated++
            }
            await checkpoint(key1)
          } else {
            const flightDiffs = diffs.filter(d => FLIGHT_FIELDS_NR.includes(d.field))
            const awbDiffs = diffs.filter(d => !FLIGHT_FIELDS_NR.includes(d.field))
            if (flightDiffs.length > 0) {
              await applyFlightDiffs(ex, existingSys, flightDiffs, updatedFlightsThisCycle)
              await checkEtdCutoffConsistency(ex, existingSys, config)
            }
            if (awbDiffs.length > 0) {
              const result = await applyDiffToSystem(ex, existingSys, awbDiffs)
              if (result.ok) {
                changesApplied++
                await db.collection('_sheet_sync_alerts').add({
                  client_id: config.client_id, client_name: config.client_name,
                  awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                  system_flight: existingSys.flightNumber,
                  etd: ex.etd, diffs: awbDiffs, alert_type: 'applied',
                  status: 'applied', created_at: admin.firestore.FieldValue.serverTimestamp(),
                })
              } else {
                await db.collection('_sheet_sync_alerts').add({
                  client_id: config.client_id, client_name: config.client_name,
                awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
                system_flight: existingSys.flightNumber,
                etd: ex.etd, diffs, alert_type: 'needs_review',
                message: result.msg,
                status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
              })
              alertsGenerated++
              }
            }
            await checkpoint(key1)
          }
          continue
        }

        const newKey = sheetNormStr(ex.awb1st)
        const isSameDay = isTodayOrPast(null, ex.etd)

        if (isSameDay) {
          await db.collection('_sheet_sync_alerts').add({
            client_id: config.client_id, client_name: config.client_name,
            awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
            system_flight: ex.flight,
            etd: ex.etd, diffs: [], alert_type: 'same_day_new',
            status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
          })
          alertsGenerated++
          await checkpoint(newKey)
        } else {
          if (circuitBroken) { delete currentHashes[newKey]; continue } // V2: circuit breaker — don't save hash for unprocessed new rows
          const result = await applyNewToSystem(ex, config.client_id, config.client_name, allFlights, bookings, DRY_RUN, dryRunLog)
          if (result.ok) {
            changesApplied++
            await db.collection('_sheet_sync_alerts').add({
              client_id: config.client_id, client_name: config.client_name,
              awb_1st: ex.awb1st, awb_2nd: ex.awb2nd, flight_number: ex.flight,
              system_flight: ex.flight,
              etd: ex.etd, diffs: [], alert_type: 'applied_new',
              message: (result.log || []).join('; '),
              status: 'applied', created_at: admin.firestore.FieldValue.serverTimestamp(),
            })
          }
          await checkpoint(newKey)
        }
        // Mark AWB as processed in this cycle
        if (key1) processedAwbsThisCycle.add(key1)
        if (key2) processedAwbsThisCycle.add(key2)
      }

      // V2 (F3): Process removed rows — cleanup L0 (no activity), alert L1+
      for (const key of removedKeys) {
        const sys = byAwb1.get(key)
        if (!sys) continue
        if (circuitBroken) break // V2: circuit breaker

        const awbNorm = sheetNormStr(sys.awb1st)
        const hasActivity = receivedAwbs.has(awbNorm) || builtAwbs.has(awbNorm) || sys.dispatched

        if (hasActivity) {
          // L1+: AWB has warehouse activity — do NOT touch, only alert
          await db.collection('_sheet_sync_alerts').add({
            client_id: config.client_id, client_name: config.client_name,
            awb_1st: sys.awb1st, awb_2nd: sys.awb2nd, flight_number: sys.flightNumber,
            system_flight: sys.flightNumber,
            etd: sys.etd, diffs: [], alert_type: 'removed_from_sheet_protected',
            message: `AWB has warehouse activity — requires manual removal`,
            status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
          })
          alertsGenerated++
          checkCircuitBreaker('gate_blocked')
        } else if (DRY_RUN) {
          // L0 in dry-run: log what would happen
          dryRunLog.push({ type: 'would_remove_awb', awb: sys.awb1st, from_booking: sys.bookingId, flight: sys.flightNumber, reason: 'not_in_sheet_L0' })
        } else {
          // L0: AWB has NO activity — safe to auto-remove
          const removed = await removeAwbFromBooking(sys.bookingId, sys.awb1st)
          await db.collection('_sheet_sync_alerts').add({
            client_id: config.client_id, client_name: config.client_name,
            awb_1st: sys.awb1st, awb_2nd: sys.awb2nd, flight_number: sys.flightNumber,
            system_flight: sys.flightNumber,
            etd: sys.etd, diffs: [], alert_type: removed ? 'removed_from_sheet_cleaned' : 'removed_from_sheet_failed',
            message: removed ? `AWB auto-removed (no warehouse activity)` : `Failed to remove AWB from booking`,
            status: removed ? 'applied' : 'pending',
            created_at: admin.firestore.FieldValue.serverTimestamp(),
          })
          if (removed) changesApplied++
          else alertsGenerated++
        }
      }

      // 7. Update snapshot
      await snapshotRef.set({
        client_id: config.client_id, month_key: monthKey, tab_name: tabName,
        row_hashes: currentHashes, row_count: sheetRows.length,
        last_checked_at: admin.firestore.FieldValue.serverTimestamp(),
        last_changed_at: admin.firestore.FieldValue.serverTimestamp(),
        last_sync_at: changesApplied > 0 ? admin.firestore.FieldValue.serverTimestamp() : (snapshotDoc.exists ? snapshotDoc.data().last_sync_at : null),
      })

      // 8. Write back ON-HAND DATE and DROPPED OFF DATE/TIME to the sheet
      let totalWritten = 0
      for (const tabResult of tabParseResults) {
        try {
          const { written } = await writeBackStatusToSheet(
            sheets, config.spreadsheet_id, tabResult.tabTitle,
            tabResult.rows, byAwb1, byAwb2, tabResult.colMap, tabResult.sheetId
          )
          totalWritten += written
        } catch (err) {
          console.error(`Sheet sync [${config.client_name}]: Write-back to "${tabResult.tabTitle}" failed:`, err.message)
          runLog.errors.push(`Write-back "${tabResult.tabTitle}": ${err.message}`)
        }
      }
      if (totalWritten > 0) {
        console.log(`Sheet sync [${config.client_name}]: Wrote ${totalWritten} status cells back to sheet`)
      }

      // 9. Auto-sync holds from bookings → airfreight_holds collection
      let holdsSynced = 0
      try {
        // Re-fetch bookings that may have been updated in this cycle
        const updatedBookingsSnap = await db.collection('airfreight_bookings')
          .where('client_id', '==', config.client_id)
          .where('booking_type', '==', 'ecommerce')
          .get()
        const existingHoldsSnap = await db.collection('airfreight_holds')
          .where('client_id', '==', config.client_id)
          .get()
        // Build lookup: bookingId|awb|bag|box → holdDoc
        const existingHoldKeys = new Map()
        existingHoldsSnap.docs.forEach(d => {
          const hd = d.data()
          const key = `${hd.booking_id}|${hd.awb_number}|${hd.bag}|${hd.box}`
          existingHoldKeys.set(key, { id: d.id, ...hd })
        })
        const syncNow = new Date().toISOString()
        for (const bDoc of updatedBookingsSnap.docs) {
          const b = bDoc.data()
          if (!b.awb_lines) continue
          const flight = flightMap.get(b.flight_id)
          const flightDate = (flight && flight.flight_datetime) ? flight.flight_datetime.slice(0, 10) : ''
          const flightNumber = (flight && flight.flight_number) || b.flight_number || ''
          for (const line of b.awb_lines) {
            if (!line.holds || line.holds.length === 0) continue
            for (const hi of line.holds) {
              if (!hi.bag && !hi.box) continue
              // Skip placeholder "hold" values
              const bagLower = (hi.bag || '').toLowerCase().trim()
              if (bagLower === 'hold') continue
              const key = `${bDoc.id}|${line.awb_number || ''}|${hi.bag}|${hi.box}`
              if (existingHoldKeys.has(key)) {
                // Update placeholder data in existing holds
                const existing = existingHoldKeys.get(key)
                if (existing.bag === 'hold' || existing.box === 'hold') {
                  await db.collection('airfreight_holds').doc(existing.id).update({
                    bag: hi.bag, box: hi.box, updated_at: syncNow,
                  })
                  holdsSynced++
                }
                continue
              }
              await db.collection('airfreight_holds').add({
                booking_id: bDoc.id,
                flight_id: b.flight_id || '',
                flight_number: flightNumber,
                flight_date: flightDate,
                client_id: b.client_id || '',
                client_name: b.client_name || '',
                awb_number: line.awb_number || '',
                bag: hi.bag || '',
                box: hi.box || '',
                status: hi.photo?.url ? 'photo_taken' : 'informed',
                hold_photo: hi.photo || null,
                created_at: syncNow,
              })
              holdsSynced++
            }
          }
        }
        if (holdsSynced > 0) {
          console.log(`Sheet sync [${config.client_name}]: ${holdsSynced} holds synced to airfreight_holds`)
        }
      } catch (err) {
        console.error(`Sheet sync [${config.client_name}]: Holds sync error:`, err.message)
        runLog.errors.push(`Holds sync: ${err.message}`)
      }

      totalChanges += changesApplied
      totalAlerts += alertsGenerated

      runLog.holds_synced = holdsSynced
      runLog.rows_checked = sheetRows.length
      // DIAG: Persist colMap per tab for header detection debugging
      runLog.tab_col_maps = tabParseResults.map(t => ({ tab: t.tabTitle, colMap: t.colMap }))
      runLog.changes_detected = changedRows.length + newRows.length + removedKeys.length
      runLog.changes_applied = changesApplied
      runLog.alerts_generated = alertsGenerated
      runLog.cells_written_back = totalWritten
      runLog.dry_run = DRY_RUN
      runLog.circuit_broken = circuitBroken
      runLog.cb_flights_created = cbFlightsCreated
      runLog.cb_awbs_moved = cbAwbsMoved
      runLog.cb_gate_blocks = cbGateBlocks
      runLog.status = circuitBroken ? 'circuit_broken' : runLog.errors.length > 0 ? 'partial' : 'success'
      runLog.duration_ms = Date.now() - runStart
      await db.collection('_sheet_sync_runs').add(runLog)

      // V2: Save dry-run log for review
      if (DRY_RUN && dryRunLog.length > 0) {
        await db.collection('_sheet_sync_dry_runs').add({
          client_id: config.client_id, client_name: config.client_name,
          run_at: new Date().toISOString(),
          actions: dryRunLog,
          summary: {
            would_create_flights: dryRunLog.filter(l => l.type === 'would_create_flight').length,
            would_move_awbs: dryRunLog.filter(l => l.type && l.type.startsWith('would_move')).length,
            would_add_awbs: dryRunLog.filter(l => l.type === 'would_add_new_awb').length,
            would_remove_awbs: dryRunLog.filter(l => l.type === 'would_remove_awb').length,
          },
        })
      }

      console.log(`Sheet sync [${config.client_name}]${DRY_RUN ? ' [DRY-RUN]' : ''}: ${changesApplied} applied, ${alertsGenerated} alerts, ${sheetRows.length} rows checked, ${totalWritten} written back${circuitBroken ? ' [CIRCUIT BROKEN]' : ''}`)

    } catch (err) {
      console.error(`Sheet sync [${config.client_name}] error:`, err)
      runLog.errors.push(err.message)
      runLog.status = 'error'
      runLog.duration_ms = Date.now() - runStart
      await db.collection('_sheet_sync_runs').add(runLog)
    }
  }

  return { totalChanges, totalAlerts }
}

// ── Scheduled: every 30 minutes ──

exports.sheetSyncAgent = onSchedule({
  schedule: '*/30 7-23 * * *',
  timeZone: 'America/New_York',
  region: 'us-east1',
  timeoutSeconds: 300,
  memory: '512MiB',
}, async () => {
  const result = await runSheetSync()
  console.log('Sheet sync completed:', result)
})

// ── Manual trigger (callable from admin UI) ──

exports.sheetSyncManual = onCall({
  region: 'us-east1',
  timeoutSeconds: 300,
  memory: '512MiB',
}, async (request) => {
  // Optionally filter to a specific client
  const clientId = request.data?.clientId
  let configOverride = null
  if (clientId) {
    const doc = await db.collection('_sheet_sync_configs').doc(clientId).get()
    if (!doc.exists) throw new HttpsError('not-found', 'Config not found for client: ' + clientId)
    configOverride = doc
  }
  const result = await runSheetSync(configOverride)
  return result
})

// ══════════════════════════════════════════════════════════════════════════════
// ── Cross Check: Billing vs Sheet ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Read-only cross check: compares AWBs in the client spreadsheet (current month)
 * against air_billing_charges / air_invoices to find unbilled AWBs.
 */
async function runCrossCheck(clientIdFilter) {
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] })
  const sheets = google.sheets({ version: 'v4', auth })

  const configsSnap = clientIdFilter
    ? await db.collection('_sheet_sync_configs').where('client_id', '==', clientIdFilter).where('enabled', '==', true).get()
    : await db.collection('_sheet_sync_configs').where('enabled', '==', true).get()

  if (configsSnap.empty) return { error: 'No enabled configs found' }

  const results = []
  const todayISO = new Date().toISOString().slice(0, 10)
  const monthKey = new Date().toISOString().slice(0, 7) // "2026-05"

  for (const configDoc of configsSnap.docs) {
    const config = configDoc.data()
    const clientId = config.client_id
    const clientName = config.client_name || clientId

    try {
      // 1. Read sheet tabs for current month
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: config.spreadsheet_id,
        fields: 'sheets.properties.title',
      })
      const allTabTitles = (meta.data.sheets || []).map(s => s.properties.title)
      const tabsToRead = config.tab_name_override
        ? [{ tabTitle: config.tab_name_override, monthOffset: 0 }]
        : findMonthTabs(allTabTitles, config.tab_name_pattern || 'month_es')

      if (tabsToRead.length === 0) {
        results.push({ client_id: clientId, client_name: clientName, error: 'No tab found for current month' })
        continue
      }

      // 2. Parse sheet rows
      let sheetRows = []
      for (const { tabTitle } of tabsToRead) {
        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: config.spreadsheet_id,
          range: `'${tabTitle}'`,
          valueRenderOption: 'UNFORMATTED_VALUE',
        })
        const parseResult = parseSheetRows(resp.data.values || [])
        sheetRows = sheetRows.concat(parseResult.rows)
      }

      // Deduplicate by AWB
      const deduped = new Map()
      for (const row of sheetRows) {
        const key = sheetNormStr(row.awb1st) || sheetNormStr(row.awb2nd)
        if (key) deduped.set(key, row)
      }
      sheetRows = [...deduped.values()]

      // 3. Classify: exclude ETD > today
      const excluded = []
      const toAnalyze = []
      for (const row of sheetRows) {
        const etdDate = (row.etd || '').slice(0, 10)
        if (etdDate && etdDate > todayISO) {
          excluded.push(row)
        } else {
          toAnalyze.push(row)
        }
      }

      // 4. Load billing charges for this client (non-voided)
      const chargesSnap = await db.collection('air_billing_charges')
        .where('client_id', '==', clientId)
        .get()
      const charges = chargesSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(c => c.status !== 'voided')

      // Build lookup: normalized AWB -> charges array
      const normAwb = s => (s || '').replace(/[\s\-]/g, '').toUpperCase()
      const chargesByAwb = new Map() // normAwb -> [{ charge, invoiced, flightNumber, awb1st, awb2nd }]
      for (const c of charges) {
        const keys = [normAwb(c.awb_1st_leg), normAwb(c.awb_2nd_leg)].filter(Boolean)
        const entry = {
          charge: c,
          invoiced: c.status === 'invoiced' && !!c.invoice_id,
          billingPending: c.status === 'pending',
          flightNumber: c.flight_number || '',
          awb1st: c.awb_1st_leg || '',
          awb2nd: c.awb_2nd_leg || '',
          invoiceId: c.invoice_id || null,
        }
        for (const k of keys) {
          if (!chargesByAwb.has(k)) chargesByAwb.set(k, [])
          chargesByAwb.get(k).push(entry)
        }
      }

      // 5. Classify each analyzed AWB
      const invoicedAwbs = []
      const billingNoInvoice = []
      const noBilling = []
      const flightMismatches = []
      const awb2ndMismatches = []

      for (const row of toAnalyze) {
        const key1 = normAwb(row.awb1st)
        const key2 = normAwb(row.awb2nd)
        const matchedCharges = (key1 && chargesByAwb.get(key1)) || (key2 && chargesByAwb.get(key2)) || []

        if (matchedCharges.length === 0) {
          noBilling.push(formatSheetRow(row))
          continue
        }

        const hasInvoiced = matchedCharges.some(m => m.invoiced)
        const hasBillingPending = matchedCharges.some(m => m.billingPending)

        if (hasInvoiced) {
          invoicedAwbs.push(formatSheetRow(row))
          // Check flight mismatch
          const invoicedEntry = matchedCharges.find(m => m.invoiced)
          if (invoicedEntry && row.flight) {
            const sheetFlight = sheetNormStr(row.flight)
            const invFlight = sheetNormStr(invoicedEntry.flightNumber)
            if (sheetFlight && invFlight && sheetFlight !== invFlight) {
              flightMismatches.push({
                awb1st: row.awb1st, awb2nd: row.awb2nd,
                sheetFlight: row.flight, invoiceFlight: invoicedEntry.flightNumber,
                invoiceId: invoicedEntry.invoiceId,
              })
            }
          }
          // Check 2nd leg mismatch
          if (invoicedEntry && row.awb2nd) {
            const sheet2nd = normAwb(row.awb2nd)
            const inv2nd = normAwb(invoicedEntry.awb2nd)
            if (sheet2nd && inv2nd && sheet2nd !== inv2nd) {
              awb2ndMismatches.push({
                awb1st: row.awb1st, sheet2ndLeg: row.awb2nd,
                invoice2ndLeg: invoicedEntry.awb2nd, invoiceFlight: invoicedEntry.flightNumber,
              })
            }
          }
        } else if (hasBillingPending) {
          billingNoInvoice.push(formatSheetRow(row))
        } else {
          noBilling.push(formatSheetRow(row))
        }
      }

      // 6. Save report
      const report = {
        client_id: clientId,
        client_name: clientName,
        month: monthKey,
        run_at: new Date().toISOString(),
        total_in_sheet: sheetRows.length,
        total_excluded_etd: excluded.length,
        total_analyzed: toAnalyze.length,
        total_invoiced: invoicedAwbs.length,
        total_billing_no_invoice: billingNoInvoice.length,
        total_no_billing: noBilling.length,
        total_flight_mismatch: flightMismatches.length,
        total_awb_mismatch: awb2ndMismatches.length,
        no_billing: noBilling,
        billing_no_invoice: billingNoInvoice,
        flight_mismatches: flightMismatches,
        awb_mismatches: awb2ndMismatches,
      }

      const reportId = `${clientId}_${monthKey}`
      await db.collection('_crosscheck_reports').doc(reportId).set(report)
      results.push(report)

    } catch (err) {
      console.error(`Cross check [${clientName}]:`, err)
      results.push({ client_id: clientId, client_name: clientName, error: err.message })
    }
  }

  return results.length === 1 ? results[0] : results
}

function formatSheetRow(row) {
  return {
    flight: row.flight || '',
    awb1st: row.awb1st || '',
    awb2nd: row.awb2nd || '',
    uld: row.uld || '',
    pcs: row.pcs || 0,
    cw: row.cw || 0,
    pickupFrom: row.pickupFrom || '',
    deliverTo: row.deliverTo || '',
    dest: row.dest || '',
    etd: row.etd || '',
    cutoff: row.cutoff || '',
    onHandDate: row.onHandDateCell || '',
  }
}

// ── Nightly cron: 3 AM EST ──

exports.crossCheckNightly = onSchedule({
  schedule: '0 3 * * *',
  timeZone: 'America/New_York',
  region: 'us-east1',
  timeoutSeconds: 120,
  memory: '256MiB',
}, async () => {
  const result = await runCrossCheck()
  console.log('Cross check nightly completed:', JSON.stringify(result).slice(0, 500))
})

exports.crossCheckManual = onCall({
  region: 'us-east1',
  timeoutSeconds: 120,
  memory: '256MiB',
}, async (request) => {
  const clientId = request.data?.clientId || null
  return await runCrossCheck(clientId)
})

// ══════════════════════════════════════════════════════════════════════════════
// ── Cargo Tracking Agent ─────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

/*
 * Scrapes airline tracking websites for inbound cargo status.
 * Runs 3x/day: 5AM, 5PM, 9PM ET.
 * Searches by 1st leg AWB (never 2nd leg).
 * Writes tracking_* fields into awb_lines[] in Firestore.
 */

// ── Airline scraper definitions ──

// Status code labels for display
const IATA_STATUS_LABELS = {
  BKD: 'Booked', RCS: 'Received from Shipper', MAN: 'Manifested',
  ULD: 'ULD Assigned', DEP: 'Departed', ARR: 'Arrived',
  RCF: 'Received from Flight', NFD: 'Notified for Delivery', DLV: 'Delivered',
}

// API-based airlines: called via fetch(), no Puppeteer needed
const AIRLINE_API = {
  '369': {
    name: 'Atlas Air', iata: '5Y',
    async track(prefix, number) {
      const url = `https://jumpseat.atlasair.com/tracktraceapi/api/FreightContProvdr/GetFriegtDtlByAwbNo?prfx=${prefix}&serial=${number}`
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) throw new Error(`Atlas API ${resp.status}`)
      const data = await resp.json()

      // No data: Origin is null and no milestones
      if (!data.Origin && (!data.LstFrieghtDtlEnhanced || data.LstFrieghtDtlEnhanced.length === 0)) {
        return null // signal: AWB not found / no data yet
      }

      const result = {
        flight: null, eta: null, origin: data.Origin || null,
        status: null, pieces: data.Pieces || null, weight: data.Weight || null,
        uld: null, legs: [],
      }

      // Parse milestones from LstFrieghtDtlEnhanced
      const milestones = data.LstFrieghtDtlEnhanced || []
      for (const m of milestones) {
        if (!m.Status) continue
        const flight = (m.Carrier && m.FlightNo) ? `${m.Carrier}${m.FlightNo}` : null

        // Extract ULDs before remapping status
        if (m.Status === 'ULD' && m.LstULDDetail && m.LstULDDetail.length > 0) {
          result.uld = m.LstULDDetail.map(u => u.ULDNumber).join(', ')
        }

        // Atlas uses ULD instead of DEP — remap to standard IATA DEP
        const status = m.Status === 'ULD' ? 'DEP' : m.Status
        result.legs.push({
          station: m.Origin || '',
          status,
          label: IATA_STATUS_LABELS[status] || status,
          time: m.DtTime || m.DtTimeStr || '',
          flight: flight,
          pieces: m.Pieces || null,
          weight: m.Weight || null,
        })
      }

      // Determine overall status from LstStatus (ordered array) or last leg
      if (data.LstStatus && data.LstStatus.length > 0) {
        // Remap ULD → DEP in overall status too
        const lastStatus = data.LstStatus[data.LstStatus.length - 1]
        result.status = lastStatus === 'ULD' ? 'DEP' : lastStatus
      } else if (result.legs.length > 0) {
        result.status = result.legs[result.legs.length - 1].status
      }

      // Extract flight from BKD entry (the booking) or first entry with carrier
      const bkdEntry = milestones.find(m => m.Status === 'BKD' && m.Carrier && m.FlightNo)
      const anyFlight = milestones.find(m => m.Carrier && m.FlightNo)
      const flightEntry = bkdEntry || anyFlight
      if (flightEntry) {
        result.flight = `${flightEntry.Carrier}${flightEntry.FlightNo}`
      }

      // ETA: use ARR milestone time
      const arrEntry = milestones.find(m => m.Status === 'ARR')
      if (arrEntry) result.eta = arrEntry.DtTime || arrEntry.DtTimeStr || null

      return result
    },
  },

  '235': {
    name: 'Turkish Cargo', iata: 'TK',
    async track(prefix, number) {
      const url = 'https://www.turkishcargo.com/api/proxy/onlineServices/shipmentTracking'
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify({
          trackingFilters: [{ shipmentPrefix: prefix, masterDocumentNumber: number }],
        }),
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) throw new Error(`Turkish API ${resp.status}`)
      const data = await resp.json()

      if (data.status !== 'SUCCESS' || !data.result?.shipmentTrackings?.length) {
        return null
      }

      const shipment = data.result.shipmentTrackings[0]
      const result = {
        flight: null, eta: null, origin: shipment.originCode || null,
        status: null, pieces: shipment.pieces || null, weight: shipment.weight || null,
        uld: null, legs: [],
      }

      // Use trackingHistoryDetails for full milestone history
      const history = shipment.trackingHistoryDetails || []
      for (const h of history) {
        if (!h.status) continue
        result.legs.push({
          station: h.station || '',
          status: h.status,
          label: IATA_STATUS_LABELS[h.status] || h.description || h.status,
          time: h.actualDatetime || '',
          flight: h.flightNo || null,
          pieces: h.actualPieces || null,
          weight: h.actualWeight || null,
        })
      }

      // Overall status: last history entry
      if (result.legs.length > 0) {
        result.status = result.legs[result.legs.length - 1].status
      }

      // Flight: from bookingFlightDetails, last leg going to MIA (or last entry)
      const flights = shipment.bookingFlightDetails || []
      if (flights.length > 0) {
        const miaFlight = flights.find(f => f.destinationCode === 'MIA') || flights[flights.length - 1]
        result.flight = `${miaFlight.carrierCode}${miaFlight.flightNumber}`
        if (miaFlight.eta) result.eta = miaFlight.eta
      }

      return result
    },
  },

  '936': {
    name: 'DHL Aviation Cargo', iata: 'D0',
    async track(prefix, number) {
      const url = `https://aviationcargo.dhl.com/track/${prefix}-${number}`
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
        },
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) throw new Error(`DHL HTTP ${resp.status}`)
      const html = await resp.text()

      // WAF block or no data
      if (html.includes('Request Rejected') || html.includes('No results found') || html.length < 3000) {
        return null
      }

      const result = {
        flight: null, eta: null, origin: null,
        status: null, pieces: null, weight: null,
        uld: null, legs: [],
      }

      // Extract origin: "Org <strong>HKG</strong>"
      const orgMatch = html.match(/Org\s+(?:<[^>]*>)*\s*([A-Z]{3})/)
      if (orgMatch) result.origin = orgMatch[1]

      // Extract pieces/weight: "for <strong>82</strong> pieces @ <strong>1757</strong> KG"
      const pwMatch = html.match(/for\s+(?:<[^>]*>)*\s*(\d+)\s*(?:<[^>]*>)*\s*pieces\s+@\s+(?:<[^>]*>)*\s*([\d,.]+)\s*(?:<[^>]*>)*\s*KG/i)
      if (pwMatch) {
        result.pieces = parseInt(pwMatch[1])
        result.weight = parseFloat(pwMatch[2].replace(',', ''))
      }

      // Extract actual status: "Actual status:" ... "DLV - Delivery"
      const statusMatch = html.match(/Actual\s+status:.*?([A-Z]{3})\s*-\s*/s)
      if (statusMatch) result.status = statusMatch[1]

      // Parse table rows by stripping tags and splitting cells
      const knownCodes = ['BKD', 'RCS', 'MAN', 'DEP', 'ARR', 'RCF', 'NFD', 'DLV', 'FFM']
      const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
      let m
      while ((m = trRegex.exec(html)) !== null) {
        const cells = m[1].replace(/<[^>]+>/g, '|').split('|').map(c => c.trim()).filter(c => c.length > 0)
        if (cells.length < 4) continue
        const code = cells[0]
        if (!knownCodes.includes(code)) continue

        const description = cells[1] || ''
        const pcsCell = cells.find(c => c.includes('pcs'))
        const pieces = pcsCell ? parseInt(pcsCell) : null
        // Station: find 3-letter airport code that isn't the status code itself
        const station = cells.find(c => /^[A-Z]{3}$/.test(c) && c !== code) || ''
        const time = cells.find(c => /^\d{1,2}:\d{2}$/.test(c)) || ''

        let flight = null
        if (code === 'FFM') {
          const fltMatch = description.match(/movement\s+(\w+)/i)
          if (fltMatch) flight = fltMatch[1]
        }

        result.legs.push({
          station, status: code,
          label: IATA_STATUS_LABELS[code] || description,
          time, flight, pieces, weight: null,
        })
      }

      // Overall status from Actual status field or highest leg
      if (!result.status && result.legs.length > 0) {
        const order = { BKD: 0, RCS: 1, MAN: 2, DEP: 3, ARR: 4, RCF: 5, NFD: 6, DLV: 7 }
        const meaningful = result.legs.filter(l => order[l.status] !== undefined)
        if (meaningful.length > 0) {
          meaningful.sort((a, b) => (order[a.status] || 0) - (order[b.status] || 0))
          result.status = meaningful[meaningful.length - 1].status
        }
      }

      // Flight: from FFM legs
      if (!result.flight) {
        const ffmLeg = result.legs.find(l => l.flight)
        if (ffmLeg) result.flight = ffmLeg.flight
      }

      return result
    },
  },
}

// Puppeteer-based airlines (browser scraping)
const AIRLINE_SCRAPERS = {

  '160': {
    name: 'Cathay Cargo', iata: 'CX',
    async scrape(page, prefix, number) {
      await page.goto('https://www.cathaycargo.com/en-us/track-and-trace.html', { waitUntil: 'networkidle2', timeout: 30000 })
      // Wait for the form
      await page.waitForSelector('input', { timeout: 15000 })
      // Find the AWB number input (not the airline code which is pre-filled)
      const inputs = await page.$$('input[type="text"], input:not([type])')
      for (const inp of inputs) {
        const val = await inp.evaluate(el => el.value)
        const placeholder = await inp.evaluate(el => el.placeholder || el.getAttribute('aria-label') || '')
        if (val === '160' || val === prefix) continue // skip airline code field
        await inp.click({ clickCount: 3 })
        await inp.type(number, { delay: 50 })
        break
      }
      // Click Track/Submit button
      const buttons = await page.$$('button')
      for (const btn of buttons) {
        const text = await btn.evaluate(el => el.textContent.trim().toLowerCase())
        if (text.includes('track')) { await btn.click(); break }
      }
      // Wait for results
      await page.waitForFunction(() => {
        return document.querySelector('[class*="milestone"]') ||
               document.querySelector('[class*="status"]') ||
               document.querySelector('[class*="tracking-result"]') ||
               document.body.innerText.includes('DEP') ||
               document.body.innerText.includes('ARR') ||
               document.body.innerText.includes('Departed')
      }, { timeout: 20000 }).catch(() => {})
      await new Promise(r => setTimeout(r, 3000)) // extra wait for SPA rendering
      return await page.evaluate(() => {
        const result = { flight: null, eta: null, origin: null, status: null, pieces: null, weight: null, uld: null, legs: [] }
        const text = document.body.innerText
        // Extract flight from text pattern like "CX072"
        const flightMatch = text.match(/\b(CX\d{3,4})\b/)
        if (flightMatch) result.flight = flightMatch[1]
        // Extract origin from "XXX to MIA" pattern
        const routeMatch = text.match(/\b([A-Z]{3})\s+to\s+MIA\b/i)
        if (routeMatch) result.origin = routeMatch[1]
        // Extract ULD
        const uldMatch = text.match(/ULD[:\s]*([A-Z]{3}\d{5,}[A-Z0-9]*)/i)
        if (uldMatch) result.uld = uldMatch[1]
        // Extract milestones — look for IATA codes with times
        const milestonePatterns = [
          { code: 'DLV', labels: ['delivered', 'dlv'] },
          { code: 'NFD', labels: ['notified for delivery', 'nfd', 'notification of freight'] },
          { code: 'RCF', labels: ['freight accepted at airport', 'rcf', 'received cargo'] },
          { code: 'ARR', labels: ['arrived', 'arr'] },
          { code: 'DEP', labels: ['departed', 'dep'] },
          { code: 'RCS', labels: ['accepted', 'rcs', 'received from shipper'] },
          { code: 'BKD', labels: ['booked', 'bkd', 'booking received'] },
        ]
        // Parse timeline entries
        const allElements = document.querySelectorAll('div, span, p, li, td')
        const seen = new Set()
        for (const el of allElements) {
          const t = el.textContent.trim()
          if (t.length > 200 || t.length < 2) continue
          for (const mp of milestonePatterns) {
            if (seen.has(mp.code)) continue
            const hasLabel = mp.labels.some(l => t.toLowerCase().includes(l))
            if (!hasLabel) continue
            // Try to find time near this element
            const timeMatch = t.match(/(\d{1,2}[:\.]?\d{2})\s*/) ||
                             t.match(/(\d{1,2}\s+\w{3}\s+\d{4})/)
            const stationMatch = t.match(/\b([A-Z]{3})\b/)
            const fltMatch = t.match(/\b([A-Z]{2}\d{3,4})\b/)
            result.legs.push({
              station: stationMatch ? stationMatch[1] : '',
              status: mp.code,
              label: mp.labels[0],
              time: timeMatch ? timeMatch[1] : '',
              flight: fltMatch ? fltMatch[1] : undefined,
            })
            seen.add(mp.code)
          }
        }
        // Sort legs by IATA progression
        const order = { BKD: 0, RCS: 1, DEP: 2, ARR: 3, RCF: 4, NFD: 5, DLV: 6 }
        result.legs.sort((a, b) => (order[a.status] || 0) - (order[b.status] || 0))
        if (result.legs.length > 0) {
          result.status = result.legs[result.legs.length - 1].status
          const arrLeg = result.legs.find(l => l.status === 'ARR')
          if (arrLeg && arrLeg.time) result.eta = arrLeg.time
        }
        return result
      })
    },
  },

  '172': {
    name: 'Cargolux', iata: 'CV',
    async scrape(page, prefix, number) {
      await page.goto('https://www.cargolux.com/e-services/e-tracking', { waitUntil: 'networkidle2', timeout: 30000 })
      await page.waitForSelector('input', { timeout: 15000 })
      const inputs = await page.$$('input[type="text"], input:not([type])')
      for (const inp of inputs) {
        const val = await inp.evaluate(el => el.value)
        if (val === '172' || val === prefix) continue
        await inp.click({ clickCount: 3 })
        await inp.type(number, { delay: 50 })
        break
      }
      const buttons = await page.$$('button, input[type="submit"]')
      for (const btn of buttons) {
        const t = await btn.evaluate(el => el.textContent.trim().toLowerCase())
        if (t.includes('track') || t.includes('search') || t.includes('submit')) { await btn.click(); break }
      }
      await new Promise(r => setTimeout(r, 5000))
      return await page.evaluate(() => {
        const result = { flight: null, eta: null, origin: null, status: null, pieces: null, weight: null, uld: null, legs: [] }
        const text = document.body.innerText
        const fltMatch = text.match(/\b(CV\d{3,4})\b/)
        if (fltMatch) result.flight = fltMatch[1]
        const codes = ['DLV','NFD','RCF','ARR','DEP','RCS','BKD']
        const codeLabels = { DLV:'Delivered', NFD:'Notified', RCF:'Received from flight', ARR:'Arrived', DEP:'Departed', RCS:'Received', BKD:'Booked' }
        for (const code of codes) {
          if (text.includes(code) || text.includes(`(${code})`)) {
            result.legs.push({ station: '', status: code, label: codeLabels[code] || code, time: '' })
          }
        }
        const order = { BKD:0, RCS:1, DEP:2, ARR:3, RCF:4, NFD:5, DLV:6 }
        result.legs.sort((a, b) => (order[a.status]||0) - (order[b.status]||0))
        if (result.legs.length) result.status = result.legs[result.legs.length - 1].status
        return result
      })
    },
  },

  '297': {
    name: 'China Airlines', iata: 'CI',
    async scrape(page, prefix, number) {
      await page.goto('https://cargo.china-airlines.com/ccnetv2/content/manage/cargo-tracking.aspx', { waitUntil: 'networkidle2', timeout: 30000 })
      await page.waitForSelector('input', { timeout: 15000 })
      const inputs = await page.$$('input[type="text"], input:not([type])')
      for (const inp of inputs) {
        const val = await inp.evaluate(el => el.value)
        if (val === '297' || val === prefix) continue
        await inp.click({ clickCount: 3 })
        await inp.type(number, { delay: 50 })
        break
      }
      const buttons = await page.$$('button, input[type="submit"], a[class*="btn"]')
      for (const btn of buttons) {
        const t = await btn.evaluate(el => el.textContent.trim().toLowerCase())
        if (t.includes('track') || t.includes('search') || t.includes('submit') || t.includes('query')) { await btn.click(); break }
      }
      await new Promise(r => setTimeout(r, 5000))
      return await page.evaluate(() => {
        const result = { flight: null, eta: null, origin: null, status: null, pieces: null, weight: null, uld: null, legs: [] }
        const text = document.body.innerText
        const fltMatch = text.match(/\b(CI\d{3,4})\b/)
        if (fltMatch) result.flight = fltMatch[1]
        const codes = ['DLV','NFD','RCF','ARR','DEP','RCS','BKD']
        const codeLabels = { DLV:'Delivered', NFD:'Notified', RCF:'Received from flight', ARR:'Arrived', DEP:'Departed', RCS:'Received', BKD:'Booked' }
        for (const code of codes) {
          if (text.includes(code) || text.includes(`(${code})`)) {
            result.legs.push({ station: '', status: code, label: codeLabels[code] || code, time: '' })
          }
        }
        const order = { BKD:0, RCS:1, DEP:2, ARR:3, RCF:4, NFD:5, DLV:6 }
        result.legs.sort((a, b) => (order[a.status]||0) - (order[b.status]||0))
        if (result.legs.length) result.status = result.legs[result.legs.length - 1].status
        return result
      })
    },
  },

  '501': {
    name: 'Silk Way West', iata: '7L',
    async scrape(page, prefix, number) {
      await page.goto('https://www.silkwaywest.com/en/cargo-tracking', { waitUntil: 'networkidle2', timeout: 30000 })
      await page.waitForSelector('input', { timeout: 15000 })
      const input = await page.$('input[type="text"], input:not([type])')
      if (input) {
        await input.click({ clickCount: 3 })
        await input.type(`${prefix}-${number}`, { delay: 50 })
      }
      const buttons = await page.$$('button, input[type="submit"]')
      for (const btn of buttons) {
        const t = await btn.evaluate(el => el.textContent.trim().toLowerCase())
        if (t.includes('track') || t.includes('search') || t.includes('submit')) { await btn.click(); break }
      }
      await new Promise(r => setTimeout(r, 5000))
      return await page.evaluate(() => {
        const result = { flight: null, eta: null, origin: null, status: null, pieces: null, weight: null, uld: null, legs: [] }
        const text = document.body.innerText
        const fltMatch = text.match(/\b(7L\d{3,4})\b/)
        if (fltMatch) result.flight = fltMatch[1]
        const codes = ['DLV','NFD','RCF','ARR','DEP','RCS','BKD']
        const codeLabels = { DLV:'Delivered', NFD:'Notified', RCF:'Received from flight', ARR:'Arrived', DEP:'Departed', RCS:'Received', BKD:'Booked' }
        for (const code of codes) {
          if (text.includes(code) || text.includes(`(${code})`)) {
            result.legs.push({ station: '', status: code, label: codeLabels[code] || code, time: '' })
          }
        }
        const order = { BKD:0, RCS:1, DEP:2, ARR:3, RCF:4, NFD:5, DLV:6 }
        result.legs.sort((a, b) => (order[a.status]||0) - (order[b.status]||0))
        if (result.legs.length) result.status = result.legs[result.legs.length - 1].status
        return result
      })
    },
  },

  '999': {
    name: 'Air China Cargo', iata: 'CA',
    async scrape(page, prefix, number) {
      await page.goto('https://www.airchinacargo.com/en/tracking', { waitUntil: 'networkidle2', timeout: 30000 })
      await page.waitForSelector('input', { timeout: 15000 })
      const inputs = await page.$$('input[type="text"], input:not([type])')
      for (const inp of inputs) {
        const val = await inp.evaluate(el => el.value)
        if (val === '999' || val === prefix) continue
        await inp.click({ clickCount: 3 })
        await inp.type(number, { delay: 50 })
        break
      }
      const buttons = await page.$$('button, input[type="submit"]')
      for (const btn of buttons) {
        const t = await btn.evaluate(el => el.textContent.trim().toLowerCase())
        if (t.includes('track') || t.includes('search') || t.includes('submit') || t.includes('query')) { await btn.click(); break }
      }
      await new Promise(r => setTimeout(r, 5000))
      return await page.evaluate(() => {
        const result = { flight: null, eta: null, origin: null, status: null, pieces: null, weight: null, uld: null, legs: [] }
        const text = document.body.innerText
        const fltMatch = text.match(/\b(CA\d{3,4})\b/)
        if (fltMatch) result.flight = fltMatch[1]
        const codes = ['DLV','NFD','RCF','ARR','DEP','RCS','BKD']
        const codeLabels = { DLV:'Delivered', NFD:'Notified', RCF:'Received from flight', ARR:'Arrived', DEP:'Departed', RCS:'Received', BKD:'Booked' }
        for (const code of codes) {
          if (text.includes(code) || text.includes(`(${code})`)) {
            result.legs.push({ station: '', status: code, label: codeLabels[code] || code, time: '' })
          }
        }
        const order = { BKD:0, RCS:1, DEP:2, ARR:3, RCF:4, NFD:5, DLV:6 }
        result.legs.sort((a, b) => (order[a.status]||0) - (order[b.status]||0))
        if (result.legs.length) result.status = result.legs[result.legs.length - 1].status
        return result
      })
    },
  },
}

// ── Core tracking logic ──

async function runTrackingAgent() {
  const now = new Date().toISOString()
  const log = (msg) => console.log(`[TrackingAgent] ${msg}`)

  // Check config
  const configSnap = await db.collection('_tracking_config').doc('settings').get()
  const config = configSnap.exists ? configSnap.data() : {}
  if (config.enabled === false) { log('Disabled via config'); return { skipped: true } }

  // Collect eligible AWBs: only those with LFD or Ready for Pickup in range day-1 to day+3
  log('Querying eligible AWBs (LFD/Ready range: day-1 to day+3)...')
  const today = new Date()
  const dayMinus1 = new Date(today); dayMinus1.setDate(today.getDate() - 1)
  const dayPlus3 = new Date(today); dayPlus3.setDate(today.getDate() + 3)
  const fromDate = dayMinus1.toISOString().slice(0, 10) // YYYY-MM-DD
  const toDate = dayPlus3.toISOString().slice(0, 10)
  log(`Date range: ${fromDate} to ${toDate}`)

  // Query bookings created in last 60 days (broad net); real filter is LFD/Ready per line
  const lookback = new Date(today); lookback.setDate(today.getDate() - 60)
  const bookingsSnap = await db.collection('airfreight_bookings')
    .where('created_at', '>=', lookback.toISOString().slice(0, 10))
    .get()

  const awbsToTrack = [] // { bookingId, awbIdx, prefix, number, fullAwb, splitSuffix }

  for (const doc of bookingsSnap.docs) {
    const b = doc.data()
    if (b.status === 'cancelled') continue
    if (!b.awb_lines || !Array.isArray(b.awb_lines)) continue

    for (let i = 0; i < b.awb_lines.length; i++) {
      const line = b.awb_lines[i]
      if (line.on_hand === true) continue
      if (line.tracking_status === 'DLV') continue

      // Filter by LFD or Ready for Pickup date in range [day-1, day+3]
      const lfd = (line.last_day_free || '').slice(0, 10)
      const ready = (line.ready_for_pickup || '').slice(0, 10)
      const dateToCheck = lfd || ready || ''
      // If no date set, include it (new AWB, needs tracking)
      if (dateToCheck && (dateToCheck < fromDate || dateToCheck > toDate)) continue

      const rawAwb = line.awb_number || ''
      if (!rawAwb) continue

      // Parse AWB: "369-98155993" or "369-88210455-A" (split)
      const match = rawAwb.match(/^(\d{3})-(\d{7,8})(?:-([A-Z]))?$/)
      if (!match) continue

      const prefix = match[1]
      if (!AIRLINE_API[prefix] && !AIRLINE_SCRAPERS[prefix]) continue // unsupported airline

      // Check if airline is enabled in config
      const airlineConfig = config.airlines?.[prefix]
      if (airlineConfig?.enabled === false) continue

      awbsToTrack.push({
        bookingId: doc.id,
        awbIdx: i,
        prefix: match[1],
        number: match[2],
        fullAwb: rawAwb,
        splitSuffix: match[3] || null,
      })
    }
  }

  // Deduplicate: same AWB number may appear in multiple bookings
  // Track each unique AWB only once, then propagate result to all bookings
  const uniqueAwbs = new Map() // key = prefix-number -> first entry
  const dupeMap = new Map()    // key = prefix-number -> [{bookingId, awbIdx}]
  for (const awb of awbsToTrack) {
    const key = `${awb.prefix}-${awb.number}`
    if (!uniqueAwbs.has(key)) {
      uniqueAwbs.set(key, awb)
      dupeMap.set(key, [{ bookingId: awb.bookingId, awbIdx: awb.awbIdx }])
    } else {
      dupeMap.get(key).push({ bookingId: awb.bookingId, awbIdx: awb.awbIdx })
    }
  }
  const deduped = Array.from(uniqueAwbs.values())
  log(`Found ${awbsToTrack.length} AWBs (${deduped.length} unique) to track`)

  // Batch limit: max 100 unique AWBs per run (API airlines are fast ~200ms each)
  const MAX_PER_RUN = 100
  const batch = deduped.slice(0, MAX_PER_RUN)
  if (deduped.length > MAX_PER_RUN) {
    log(`Limiting to ${MAX_PER_RUN} AWBs this run (${deduped.length - MAX_PER_RUN} deferred)`)
  }

  if (batch.length === 0) {
    await db.collection('_tracking_config').doc('settings').set({
      last_run: now, last_run_stats: { total: 0, success: 0, errors: 0 },
    }, { merge: true })
    return { total: 0 }
  }

  // Group by airline prefix, separating API vs browser airlines
  const apiAwbs = []
  const browserByAirline = {}
  for (const awb of batch) {
    if (AIRLINE_API[awb.prefix]) {
      apiAwbs.push(awb)
    } else if (AIRLINE_SCRAPERS[awb.prefix]) {
      if (!browserByAirline[awb.prefix]) browserByAirline[awb.prefix] = []
      browserByAirline[awb.prefix].push(awb)
    }
  }

  let successCount = 0
  let errorCount = 0
  const errors = []
  const debugSamples = []

  // ── Phase 1: API-based airlines (no Puppeteer needed) ──
  if (apiAwbs.length > 0) {
    // Group API AWBs by prefix for logging
    const apiByPrefix = {}
    for (const awb of apiAwbs) {
      if (!apiByPrefix[awb.prefix]) apiByPrefix[awb.prefix] = []
      apiByPrefix[awb.prefix].push(awb)
    }

    for (const [prefix, awbs] of Object.entries(apiByPrefix)) {
      const api = AIRLINE_API[prefix]
      log(`[API] Processing ${awbs.length} AWBs for ${api.name} (${prefix})...`)

      let consecutiveFails = 0
      for (const awb of awbs) {
        if (consecutiveFails >= 5) {
          log(`  Skipping remaining ${api.name} AWBs after 5 consecutive failures`)
          break
        }
        try {
          log(`  Tracking ${awb.fullAwb}...`)
          const result = await api.track(awb.prefix, awb.number)

          // Debug sample
          if (debugSamples.filter(d => d.prefix === prefix).length < 2) {
            debugSamples.push({
              prefix, awb: awb.fullAwb, mode: 'api',
              resultStatus: result?.status || null,
              resultLegs: result?.legs?.length || 0,
              resultFlight: result?.flight || null,
            })
          }

          if (!result) {
            log(`  No data for ${awb.fullAwb} (AWB not in airline system)`)
            consecutiveFails++
            // Do NOT mark tracking_last_checked — will retry next run
            continue
          }
          consecutiveFails = 0

          const update = {
            tracking_status: result.status || null,
            tracking_inbound_flight: result.flight || null,
            tracking_eta: result.eta || null,
            tracking_origin: result.origin || null,
            tracking_pieces: result.pieces || null,
            tracking_weight: result.weight || null,
            tracking_uld: result.uld || null,
            tracking_last_checked: now,
            tracking_legs: result.legs || null,
          }

          const key = `${awb.prefix}-${awb.number}`
          const targets = dupeMap.get(key) || [{ bookingId: awb.bookingId, awbIdx: awb.awbIdx }]
          for (const t of targets) {
            await updateTrackingFields(t.bookingId, t.awbIdx, update)
          }
          log(`  ${awb.fullAwb}: ${result.status || 'no-status'} | flight: ${result.flight || '?'} | eta: ${result.eta || '?'} (${targets.length} bookings)`)
          successCount++
        } catch (err) {
          errorCount++
          consecutiveFails++
          errors.push({ awb: awb.fullAwb, error: err.message })
          log(`  ERROR ${awb.fullAwb}: ${err.message}`)
          if (debugSamples.filter(d => d.prefix === prefix).length < 2) {
            debugSamples.push({ prefix, awb: awb.fullAwb, mode: 'api', error: err.message })
          }
        }

        // Small delay between API requests (rate limiting)
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000))
      }
    }
  }

  // ── Phase 2: Browser-based airlines (Puppeteer) ──
  const browserPrefixes = Object.keys(browserByAirline)
  if (browserPrefixes.length > 0) {
    log('Launching browser for scraper-based airlines...')
    const browser = await puppeteerCore.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 720 },
      executablePath: await chromium.executablePath(),
      headless: 'shell',
    })

    try {
      for (const [prefix, awbs] of Object.entries(browserByAirline)) {
        const scraper = AIRLINE_SCRAPERS[prefix]
        if (!scraper) continue
        log(`[Browser] Processing ${awbs.length} AWBs for ${scraper.name} (${prefix})...`)

        const page = await browser.newPage()
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

        let consecutiveFails = 0
        for (const awb of awbs) {
          if (consecutiveFails >= 5) {
            log(`  Skipping remaining ${scraper.name} AWBs after 5 consecutive failures`)
            break
          }
          try {
            log(`  Tracking ${awb.fullAwb}...`)
            const result = await scraper.scrape(page, awb.prefix, awb.number)

            if (debugSamples.filter(d => d.prefix === prefix).length < 2) {
              try {
                const pageUrl = page.url()
                const snippet = await page.evaluate(() => document.body.innerText.slice(0, 600))
                const tableCount = await page.evaluate(() => document.querySelectorAll('table').length)
                debugSamples.push({
                  prefix, awb: awb.fullAwb, mode: 'browser', url: pageUrl,
                  tables: tableCount,
                  resultStatus: result?.status || null,
                  resultLegs: result?.legs?.length || 0,
                  resultFlight: result?.flight || null,
                  snippet: snippet.replace(/\n/g, ' ').slice(0, 400),
                })
              } catch (_) {}
            }

            if (!result || (!result.status && result.legs.length === 0)) {
              log(`  No data for ${awb.fullAwb}`)
              consecutiveFails++
              // Do NOT mark tracking_last_checked — will retry next run
              continue
            }
            consecutiveFails = 0

            const update = {
              tracking_status: result.status || null,
              tracking_inbound_flight: result.flight || null,
              tracking_eta: result.eta || null,
              tracking_origin: result.origin || null,
              tracking_pieces: result.pieces || null,
              tracking_weight: result.weight || null,
              tracking_uld: result.uld || null,
              tracking_last_checked: now,
              tracking_legs: result.legs || null,
            }

            const key = `${awb.prefix}-${awb.number}`
            const targets = dupeMap.get(key) || [{ bookingId: awb.bookingId, awbIdx: awb.awbIdx }]
            for (const t of targets) {
              await updateTrackingFields(t.bookingId, t.awbIdx, update)
            }
            log(`  ${awb.fullAwb}: ${result.status || 'no-status'} | flight: ${result.flight || '?'} | eta: ${result.eta || '?'} (${targets.length} bookings)`)
            successCount++
          } catch (err) {
            errorCount++
            errors.push({ awb: awb.fullAwb, error: err.message })
            log(`  ERROR ${awb.fullAwb}: ${err.message}`)
            if (debugSamples.filter(d => d.prefix === prefix).length < 2) {
              try {
                const pageUrl = page.url()
                const snippet = await page.evaluate(() => document.body.innerText.slice(0, 600))
                debugSamples.push({
                  prefix, awb: awb.fullAwb, mode: 'browser', url: pageUrl, error: err.message,
                  snippet: snippet.replace(/\n/g, ' ').slice(0, 400),
                })
              } catch (_) {}
            }
          }

          await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000))
        }

        await page.close()
      }
    } finally {
      await browser.close()
      log('Browser closed')
    }
  }

  // Save run stats + debug info
  const stats = { total: deduped.length, batched: batch.length, success: successCount, errors: errorCount }
  await db.collection('_tracking_config').doc('settings').set({
    last_run: now,
    last_run_stats: stats,
    last_run_errors: errors.slice(0, 20),
    last_run_debug: debugSamples.slice(0, 10), // debug samples for diagnosis
  }, { merge: true })

  log(`Done: ${successCount} success, ${errorCount} errors out of ${batch.length} (${deduped.length} unique total)`)
  return stats
}

async function updateTrackingFields(bookingId, awbIdx, fields) {
  const ref = db.collection('airfreight_bookings').doc(bookingId)
  const snap = await ref.get()
  if (!snap.exists) return
  const data = snap.data()
  if (!data.awb_lines || awbIdx >= data.awb_lines.length) return
  const lines = [...data.awb_lines]
  lines[awbIdx] = { ...lines[awbIdx], ...fields }
  await ref.update({ awb_lines: lines })
}

// ── Scheduled function: 5AM, 10AM, 5PM, 9PM ET ──

exports.trackingAgent = onSchedule({
  schedule: '0 5,10,17,21 * * *',
  timeZone: 'America/New_York',
  region: 'us-east1',
  memory: '1GiB',
  timeoutSeconds: 540,
}, async () => {
  await runTrackingAgent()
})

// ── Manual trigger ──

exports.trackingAgentManual = onCall({
  region: 'us-east1',
  memory: '1GiB',
  timeoutSeconds: 540,
}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
  return await runTrackingAgent()
})

exports.trackingAgentRun = onRequest({
  region: 'us-east1',
  memory: '1GiB',
  timeoutSeconds: 540,
}, async (req, res) => {
  try {
    const result = await runTrackingAgent()
    res.json({ status: 'ok', ...result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// ── Avianca Check Manifest (DG keyword detection) ────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

exports.avProcessManifest = onDocumentCreated({
  document: 'av_manifest_checks/{checkId}',
  secrets: [ANTHROPIC_API_KEY],
  timeoutSeconds: 120,
  memory: '1GiB',
}, async (event) => {
  const snap = event.data
  if (!snap) return
  const data = snap.data()
  const checkId = event.params.checkId
  const checkRef = db.doc(`av_manifest_checks/${checkId}`)

  if (data.ai_status !== 'pending') return

  await checkRef.update({ ai_status: 'processing', status: 'processing' })

  try {
    // Fetch PDF
    const pdfResp = await fetch(data.doc_url)
    if (!pdfResp.ok) {
      await checkRef.update({ ai_status: 'failed', ai_error: `PDF fetch failed: HTTP ${pdfResp.status}`, status: 'pending' })
      return
    }
    const pdfBuf = await pdfResp.arrayBuffer()
    const pdfBase64 = Buffer.from(pdfBuf).toString('base64')

    // Load DG Dictionary
    const dictSnap = await db.doc('av_dg_dictionary/default').get()
    const keywords = dictSnap.exists ? (dictSnap.data().keywords || []).filter(k => k.active) : []
    const keywordList = keywords.map(k => `${k.term} (${k.category}, ${k.severity})`).join('\n')

    // Claude Vision — scan manifest for DG keywords
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() })
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: `This is a cargo manifest or shipping document for AWB ${data.awb_number}.

Your task: Extract ALL text from this document. Then check if any of the keywords below appear LITERALLY and EXACTLY (as whole words) in the extracted text.

CRITICAL RULES FOR MATCHING:
- ONLY report a keyword if the EXACT word or phrase appears written in the document text
- Do NOT infer, deduce, or guess. If "shampoo" is written, do NOT flag "alcohol" just because shampoo might contain alcohol
- Do NOT flag partial word matches. "ACOLCHADOS" does NOT match "alcohol". The word must match completely
- Match as whole words only: "acid" should NOT match "acidity" or "acidophilus"
- Case-insensitive matching is OK (e.g. "Alcohol" matches "alcohol")
- Multi-word keywords like "lithium battery" match if both words appear together in sequence

KEYWORD LIST:
${keywordList}

Return ONLY a JSON object (no markdown):
{
  "found_keywords": [
    {
      "term": "the exact keyword from the list that was found",
      "category": "category from the list",
      "severity": "warning or critical",
      "page": 1,
      "reference": "the house AWB number, entry/line number, or row identifier where the keyword was found (e.g. 'House 906-12345678', 'Entry #45', 'Row 12')",
      "context": "copy the EXACT text from the document surrounding the keyword (max 120 chars)"
    }
  ],
  "summary": "Brief summary of what cargo is described in this manifest (1-2 sentences in Spanish)"
}

Additional rules:
- Search the ENTIRE document, not just headers
- If NO keywords are found, return {"found_keywords": [], "summary": "..."}
- "page" must be the PDF page number (1-based) where the keyword appears
- "reference" must identify the specific entry, row, or house AWB so the operator can locate it quickly without reading page by page
- The "context" must be a DIRECT QUOTE from the document, not your interpretation` },
        ],
      }],
    })

    const rawText = (response.content[0]?.text || '').trim()
    console.log(`avProcessManifest: AI response for ${data.awb_number}:`, rawText)

    let parsed
    try {
      parsed = JSON.parse(rawText.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim())
    } catch {
      await checkRef.update({ ai_status: 'failed', ai_error: 'Invalid AI JSON', status: 'pending' })
      return
    }

    const flagged = parsed.found_keywords && parsed.found_keywords.length > 0
    await checkRef.update({
      ai_status: 'complete',
      status: flagged ? 'flagged' : 'clear',
      flagged_keywords: parsed.found_keywords || [],
      ai_summary: parsed.summary || '',
    })

    // Update AWB manifest_status
    if (data.awb_id) {
      const newStatus = flagged ? 'flagged' : 'clear'
      await db.doc(`av_flight_awbs/${data.awb_id}`).update({
        manifest_status: newStatus,
        updated_at: new Date().toISOString(),
      })
      // If flagged, also update dg field on AWB
      if (flagged) {
        const criticalCodes = parsed.found_keywords
          .filter(k => k.severity === 'critical')
          .map(k => k.term)
        if (criticalCodes.length > 0) {
          await db.doc(`av_flight_awbs/${data.awb_id}`).update({
            dg: true,
            dg_codes: criticalCodes,
          })
        }
      }
    }

    console.log(`avProcessManifest: ${data.awb_number} → ${flagged ? 'FLAGGED' : 'CLEAR'} (${(parsed.found_keywords || []).length} keywords)`)

    // Log manifest check event
    if (data.flight_id && data.awb_number) {
      const kwCount = (parsed.found_keywords || []).length
      await db.collection('av_awb_logs').add({
        flight_id: data.flight_id, awb_number: data.awb_number,
        event: 'manifest_checked',
        detail: flagged ? `Flagged — ${kwCount} keywords encontrados` : 'Clear — sin keywords peligrosos',
        user: data.created_by || 'Sistema', timestamp: new Date().toISOString(),
      })
    }

  } catch (err) {
    console.error(`avProcessManifest error:`, err.message)
    await checkRef.update({ ai_status: 'failed', ai_error: err.message, status: 'pending' })
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// ── Avianca Screening Agent ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
// Reads Phantom K9 emails from a SEPARATE Gmail inbox (AV_GMAIL_REFRESH_TOKEN)
// and matches screening certs to av_pallet_tags by ULD number.

function getAvGmailClient() {
  const oauth2Client = new google.auth.OAuth2(
    GMAIL_CLIENT_ID.value(),
    GMAIL_CLIENT_SECRET.value(),
    'https://developers.google.com/oauthplayground'
  )
  oauth2Client.setCredentials({ refresh_token: AV_GMAIL_REFRESH_TOKEN.value() })
  return google.gmail({ version: 'v1', auth: oauth2Client })
}

exports.avTriggerScreeningManual = onDocumentCreated({
  document: 'av_screening_triggers/{triggerId}',
  secrets: [GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, AV_GMAIL_REFRESH_TOKEN],
  timeoutSeconds: 540,
  memory: '512MiB',
}, async (event) => {
  const triggerRef = event.data?.ref
  try {
    const triggerData = event.data?.data() || {}
    await triggerRef?.update({ status: 'running', started_at: new Date().toISOString() })
    const result = await runAvScreeningProcessor({
      date_mode: triggerData.date_mode || 'since_last_run',
      from_date: triggerData.from_date || null,
      to_date: triggerData.to_date || null,
      reprocess_failed: triggerData.reprocess_failed || false,
    })
    await triggerRef?.update({ status: 'done', result, finished_at: new Date().toISOString() })
  } catch (err) {
    console.error('AV manual screening error:', err)
    await triggerRef?.update({ status: 'error', error: err.message, finished_at: new Date().toISOString() })
  }
})

/**
 * Recalculate screening_status and screened_pcs for all AWBs in a flight,
 * based on which pallet tags are screened.
 */
async function avRecalcFlightScreening(flightId) {
  const [awbSnap, ptSnap] = await Promise.all([
    db.collection('av_flight_awbs').where('flight_id', '==', flightId).get(),
    db.collection('av_pallet_tags').where('flight_id', '==', flightId).get(),
  ])

  const palletTags = ptSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  const batch = db.batch()

  for (const awbDoc of awbSnap.docs) {
    const awb = awbDoc.data()
    // Find all pallet tags that contain this AWB
    const relatedPts = palletTags.filter(pt =>
      pt.lines?.some(l => l.awb_number === awb.awb_number)
    )
    if (relatedPts.length === 0) continue

    // Sum screened pieces
    let screenedPcs = 0
    for (const pt of relatedPts) {
      if (!pt.screened) continue
      const line = pt.lines.find(l => l.awb_number === awb.awb_number)
      if (line) screenedPcs += (line.pieces || 0)
    }

    const totalPcs = awb.pieces || 0
    let status = 'pending'
    if (screenedPcs > 0 && screenedPcs >= totalPcs) status = 'complete'
    else if (screenedPcs > 0) status = 'partial'

    batch.update(awbDoc.ref, {
      screened_pcs: screenedPcs,
      screening_status: status,
    })
  }

  await batch.commit()
}

async function runAvScreeningProcessor(opts = {}) {
  const { date_mode = 'since_last_run', from_date = null, to_date = null, reprocess_failed = false } = opts
  console.log('=== AV Screening Agent: starting ===', { date_mode, from_date, to_date, reprocess_failed })

  // 1. Read settings
  const settingsDoc = await db.doc('av_screening_settings/config').get()
  const settings = settingsDoc.exists ? settingsDoc.data() : { enabled: false }

  if (!settings.enabled) {
    console.log('AV Screening agent disabled, skipping')
    return { status: 'disabled', count: 0 }
  }

  // 2. Gmail: search for Phantom K9 emails
  const gmail = getAvGmailClient()
  let gmailAccount = 'unknown'
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' })
    gmailAccount = profile.data.emailAddress || 'unknown'
    console.log(`AV Gmail account: ${gmailAccount}`)
    await db.doc('av_screening_settings/config').update({ gmail_account: gmailAccount })
  } catch (e) { console.warn('Could not get AV Gmail profile:', e.message) }

  // Build date filter based on mode
  let afterEpoch
  let beforeEpoch = null
  const now = new Date()
  if (date_mode === 'today') {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    afterEpoch = Math.floor(startOfDay.getTime() / 1000)
  } else if (date_mode === 'last_24h') {
    afterEpoch = Math.floor((now.getTime() - 24 * 60 * 60 * 1000) / 1000)
  } else if (date_mode === 'custom' && from_date) {
    afterEpoch = Math.floor(new Date(from_date).getTime() / 1000)
    if (to_date) {
      const endDate = new Date(to_date)
      endDate.setDate(endDate.getDate() + 1) // include full end day
      beforeEpoch = Math.floor(endDate.getTime() / 1000)
    }
  } else {
    // since_last_run (default)
    const lastRun = settings.last_run || '2020-01-01T00:00:00Z'
    afterEpoch = Math.floor(new Date(lastRun).getTime() / 1000)
  }

  let searchQuery = `subject:"screening result" has:attachment after:${afterEpoch}`
  if (beforeEpoch) searchQuery += ` before:${beforeEpoch}`
  console.log('AV Gmail search:', searchQuery)

  let messageIds = []
  try {
    let pageToken = undefined
    let pageCount = 0
    do {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: searchQuery,
        maxResults: 100,
        includeSpamTrash: true,
        pageToken,
      })
      messageIds.push(...(listRes.data.messages || []).map(m => m.id))
      pageToken = listRes.data.nextPageToken
      pageCount++
    } while (pageToken && pageCount < 10)
  } catch (err) {
    console.error('AV Gmail search error:', err)
    await db.doc('av_screening_settings/config').update({
      last_run_status: 'error',
      last_run: new Date().toISOString(),
    })
    return { status: 'error', error: err.message }
  }

  console.log(`AV Screening: found ${messageIds.length} emails`)
  let processed = 0
  let reprocessedCount = 0
  const flightsToRecalc = new Set()

  // ── Delete no_uld_lines docs so they can be reprocessed ──
  if (reprocess_failed && messageIds.length > 0) {
    const failedSnap = await db.collection('av_screening_certs')
      .where('status', '==', 'no_uld_lines').get()
    const failedMsgIds = new Set(messageIds)
    for (const failedDoc of failedSnap.docs) {
      const data = failedDoc.data()
      if (failedMsgIds.has(data.gmail_message_id)) {
        await failedDoc.ref.delete()
        reprocessedCount++
        console.log(`AV Screening: deleted failed cert for reprocessing: ${data.gmail_message_id}`)
      }
    }
    if (reprocessedCount > 0) console.log(`AV Screening: cleared ${reprocessedCount} failed certs for reprocessing`)
  }

  // ── Retry previously unmatched/partial certs ──
  const unmatchedSnap = await db.collection('av_screening_certs')
    .where('status', 'in', ['unmatched', 'partial']).get()
  let retried = 0
  for (const certDoc of unmatchedSnap.docs) {
    const cert = certDoc.data()
    const uldLines = cert.uld_lines || []
    if (uldLines.length === 0) continue
    let anyNewMatch = false
    let matchCount = 0
    let flId = cert.flight_id
    const updatedLines = []
    for (const ul of uldLines) {
      if (ul.matched) { matchCount++; updatedLines.push(ul); continue }
      const ptSnap = await db.collection('av_pallet_tags')
        .where('pallet_number', '==', ul.pallet_number).limit(1).get()
      if (ptSnap.empty) { updatedLines.push(ul); continue }
      const ptDoc = ptSnap.docs[0]
      await ptDoc.ref.update({ screened: true })
      if (ptDoc.data().flight_id) { flId = ptDoc.data().flight_id; flightsToRecalc.add(flId) }
      updatedLines.push({ ...ul, matched: true, pallet_tag_id: ptDoc.id })
      matchCount++
      anyNewMatch = true
      console.log(`AV Screening retry: matched ${ul.pallet_number} → ${ptDoc.id}`)
    }
    if (anyNewMatch) {
      const newStatus = matchCount === uldLines.length ? 'matched' : 'partial'
      await certDoc.ref.update({ uld_lines: updatedLines, matched_ulds: matchCount, status: newStatus, flight_id: flId, retried_at: new Date().toISOString() })
      retried++
    }
  }
  if (retried > 0) console.log(`AV Screening: retried ${retried} unmatched certs`)

  // ── Re-match certs where pallet tag was deleted and re-uploaded ──
  const matchedSnap = await db.collection('av_screening_certs')
    .where('status', '==', 'matched').get()
  let rematchCount = 0
  for (const certDoc of matchedSnap.docs) {
    const cert = certDoc.data()
    const uldLines = cert.uld_lines || []
    if (uldLines.length === 0) continue
    let anyRematch = false
    let flId = cert.flight_id
    const updatedLines = []
    for (const ul of uldLines) {
      if (ul.matched && ul.pallet_tag_id) {
        // Check if the matched pallet tag still exists
        const ptRef = db.doc(`av_pallet_tags/${ul.pallet_tag_id}`)
        const ptDoc = await ptRef.get()
        if (ptDoc.exists) {
          updatedLines.push(ul)
          continue
        }
        // PT was deleted — try to find a new one with same pallet_number
        const newPtSnap = await db.collection('av_pallet_tags')
          .where('pallet_number', '==', ul.pallet_number).limit(1).get()
        if (!newPtSnap.empty) {
          const newPt = newPtSnap.docs[0]
          await newPt.ref.update({ screened: true })
          if (newPt.data().flight_id) { flId = newPt.data().flight_id; flightsToRecalc.add(flId) }
          updatedLines.push({ ...ul, pallet_tag_id: newPt.id })
          anyRematch = true
          console.log(`AV Screening re-match: ${ul.pallet_number} old=${ul.pallet_tag_id} → new=${newPt.id}`)
        } else {
          // PT deleted and no replacement — mark as unmatched
          updatedLines.push({ ...ul, matched: false, pallet_tag_id: null })
          anyRematch = true
          console.log(`AV Screening orphan: ${ul.pallet_number} — PT deleted, no replacement`)
        }
      } else {
        updatedLines.push(ul)
      }
    }
    if (anyRematch) {
      const mc = updatedLines.filter(l => l.matched).length
      const newStatus = mc === uldLines.length ? 'matched' : (mc > 0 ? 'partial' : 'unmatched')
      await certDoc.ref.update({ uld_lines: updatedLines, matched_ulds: mc, status: newStatus, flight_id: flId, rematched_at: new Date().toISOString() })
      rematchCount++
      if (flId) flightsToRecalc.add(flId)
    }
  }
  if (rematchCount > 0) console.log(`AV Screening: re-matched ${rematchCount} certs with replaced pallet tags`)

  for (const msgId of messageIds) {
    // Skip if already processed
    const dupSnap = await db.collection('av_screening_certs')
      .where('gmail_message_id', '==', msgId).limit(1).get()
    if (!dupSnap.empty) continue

    try {
      // Fetch full message
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: msgId,
        format: 'full',
      })
      const payload = msg.data.payload || {}
      const headers = payload.headers || []
      const subject = (headers.find(h => h.name.toLowerCase() === 'subject') || {}).value || ''
      const from = (headers.find(h => h.name.toLowerCase() === 'from') || {}).value || ''
      const emailDate = (headers.find(h => h.name.toLowerCase() === 'date') || {}).value || ''

      // Parse body
      const bodyText = getEmailBodyText(payload)
      console.log('AV Screening body preview:', bodyText.substring(0, 1500))
      const extracted = parseEmailBody(bodyText)
      console.log('AV Screening extracted:', JSON.stringify({ tsa_entry: extracted.tsa_entry, screener: extracted.phantom_screener, mcl: extracted.mcl_representant, ulds: extracted.uld_lines?.length }))

      if (!extracted.uld_lines || extracted.uld_lines.length === 0) {
        console.warn(`AV Screening: no ULD lines in email ${msgId}, skipping`)
        // Save as unmatched for visibility
        await db.collection('av_screening_certs').add({
          gmail_message_id: msgId,
          gmail_subject: subject,
          gmail_from: from,
          gmail_date: emailDate,
          extracted,
          status: 'no_uld_lines',
          processed_at: new Date().toISOString(),
        })
        continue
      }

      // Download first PDF attachment
      let pdfUrl = ''
      let pdfFilename = ''
      const allParts = []
      function collectParts(p) {
        if (p.filename && p.body?.attachmentId) allParts.push(p)
        for (const sub of (p.parts || [])) collectParts(sub)
      }
      collectParts(payload)
      const pdfPart = allParts.find(p => p.filename?.toLowerCase().endsWith('.pdf'))
      if (pdfPart) {
        const att = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: msgId,
          id: pdfPart.body.attachmentId,
        })
        const pdfBuffer = Buffer.from(att.data.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
        const now = new Date()
        const storagePath = `avianca/screening-certs/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}/${msgId}_${pdfPart.filename}`
        const file = bucket.file(storagePath)
        const downloadToken = require('crypto').randomUUID()
        await file.save(pdfBuffer, {
          contentType: 'application/pdf',
          metadata: {
            contentType: 'application/pdf',
            metadata: { firebaseStorageDownloadTokens: downloadToken },
          },
        })
        pdfUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${downloadToken}`
        pdfFilename = pdfPart.filename
      }

      // Deduplicate ULD lines within this email
      const seenUlds = new Set()
      const uniqueUldLines = []
      for (const uldLine of extracted.uld_lines) {
        const normalized = `${uldLine.uld_type}${uldLine.uld_number}`.replace(/\s/g, '')
        if (!normalized || seenUlds.has(normalized)) continue
        seenUlds.add(normalized)
        uniqueUldLines.push({ ...uldLine, normalizedPallet: normalized })
      }

      // Content-based dedup: check if a cert with the same ULD set already exists
      const contentKey = [...seenUlds].sort().join('|')
      const contentDupSnap = await db.collection('av_screening_certs')
        .where('content_key', '==', contentKey)
        .where('status', 'in', ['matched', 'partial'])
        .limit(1).get()
      if (!contentDupSnap.empty) {
        console.log(`AV Screening: skipping email ${msgId} — same ULD content already processed`)
        // Still save the gmail_message_id to avoid re-fetching
        await db.collection('av_screening_certs').add({
          gmail_message_id: msgId, status: 'duplicate', content_key: contentKey,
          processed_at: new Date().toISOString(),
        })
        continue
      }

      // Match each unique ULD against av_pallet_tags → build uld_matches array
      const uldMatches = []
      let matchedCount = 0
      let certFlightId = null
      for (const uldLine of uniqueUldLines) {
        const palletNumber = uldLine.normalizedPallet
        const ptSnap = await db.collection('av_pallet_tags')
          .where('pallet_number', '==', palletNumber).limit(1).get()
        const matched = !ptSnap.empty
        const ptDoc = matched ? ptSnap.docs[0] : null
        uldMatches.push({
          pallet_number: palletNumber,
          awb: uldLine.awb,
          pieces: uldLine.pieces,
          matched,
          pallet_tag_id: ptDoc?.id || null,
        })
        if (matched) {
          matchedCount++
          await ptDoc.ref.update({ screened: true })
          const flId = ptDoc.data().flight_id
          if (flId) { certFlightId = flId; flightsToRecalc.add(flId) }
          // Log screening event for each AWB in this pallet tag (with dedup)
          const ptLines = ptDoc.data().lines || []
          const scrNow = new Date().toISOString()
          for (const ptLine of ptLines) {
            if (ptLine.awb_number) {
              // Check if already logged for this ULD+AWB combo
              const existingLog = await db.collection('av_awb_logs')
                .where('flight_id', '==', flId)
                .where('awb_number', '==', ptLine.awb_number)
                .where('event', '==', 'screening_certified')
                .where('detail', '==', `ULD: ${palletNumber}`)
                .limit(1).get()
              if (existingLog.empty) {
                await db.collection('av_awb_logs').add({
                  flight_id: flId, awb_number: ptLine.awb_number,
                  event: 'screening_certified', detail: `ULD: ${palletNumber}`,
                  user: 'screening-agent', timestamp: scrNow,
                })
              }
            }
          }
        }
      }

      // Create ONE cert doc per email
      await db.collection('av_screening_certs').add({
        gmail_message_id: msgId,
        gmail_subject: subject,
        gmail_from: from,
        gmail_date: emailDate,
        content_key: contentKey,
        screener_company: 'Phantom K9',
        screener_name: extracted.phantom_screener,
        screening_date: extracted.date,
        screening_time: extracted.time,
        mcl_representant: extracted.mcl_representant,
        tsa_entry: extracted.tsa_entry || '',
        uld_lines: uldMatches,
        total_ulds: uniqueUldLines.length,
        matched_ulds: matchedCount,
        doc_url: pdfUrl,
        doc_filename: pdfFilename,
        flight_id: certFlightId,
        status: matchedCount === uniqueUldLines.length ? 'matched' : (matchedCount > 0 ? 'partial' : 'unmatched'),
        processed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      })

      processed++
      console.log(`AV Screening: processed email ${msgId} — ${matchedCount}/${uniqueUldLines.length} ULDs matched`)

    } catch (err) {
      console.error(`AV Screening: error processing ${msgId}:`, err.message)
    }
  }

  // Recalculate screening status for affected flights
  for (const flightId of flightsToRecalc) {
    try {
      await avRecalcFlightScreening(flightId)
      console.log(`AV Screening: recalculated flight ${flightId}`)
    } catch (err) {
      console.error(`AV Screening: error recalculating flight ${flightId}:`, err.message)
    }
  }

  // Update last run
  await db.doc('av_screening_settings/config').set({
    ...settings,
    last_run: new Date().toISOString(),
    last_run_status: 'success',
    last_run_count: processed,
    gmail_account: gmailAccount,
  }, { merge: true })

  console.log(`=== AV Screening Agent: done — ${processed} emails processed, ${reprocessedCount} reprocessed ===`)
  return { status: 'success', count: processed, reprocessed: reprocessedCount, flightsRecalculated: flightsToRecalc.size }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Deletion Audit Log ───────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const MONITORED_COLLECTIONS = [
  'airfreight_bookings',
  'airfreight_doc_receptions',
  'airfreight_physical_pieces',
  'airfreight_flights',
  'airfreight_delivery_orders',
  'buildup_ulds',
]

for (const collName of MONITORED_COLLECTIONS) {
  const fnName = `logDeletion_${collName.replace(/[^a-zA-Z0-9]/g, '_')}`
  exports[fnName] = onDocumentDeleted({
    document: `${collName}/{docId}`,
    region: 'us-east1',
  }, async (event) => {
    const snap = event.data
    if (!snap) return
    await db.collection('_deletion_log').add({
      collection: collName,
      document_id: event.params.docId,
      data: snap.data(),
      deleted_at: admin.firestore.FieldValue.serverTimestamp(),
    })
  })
}

// ── getModuleMetrics (onCall v2) — POC MariaDB: conteos de solo lectura ────
// Prueba end-to-end minima del circuito Cloud Function -> pool -> MariaDB
// (Inmotion). Usada por src/pages/monitoring/ModuleMetrics.tsx.

exports.getModuleMetrics = onCall({
  timeoutSeconds: 30,
  memory: '256MiB',
  invoker: 'public',
  secrets: [MARIADB_HOST, MARIADB_PORT, MARIADB_DATABASE, MARIADB_USER, MARIADB_PASSWORD],
}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be logged in')
  const callerEmail = request.auth.token.email || ''
  if (!callerEmail.endsWith('@mincurllogistics.com')) throw new HttpsError('permission-denied', 'MCL only')

  const pool = getMariaDbPool()

  const [wrRows] = await pool.query('SELECT COUNT(*) AS total FROM warehouse_receipts')
  const [billingRows] = await pool.query('SELECT COUNT(*) AS total FROM billing_charges')

  return {
    warehouse_receipts_total: wrRows[0].total,
    billing_charges_total: billingRows[0].total,
  }
})
