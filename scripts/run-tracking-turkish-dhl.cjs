/**
 * Force run tracking for Turkish Cargo (235) and DHL Aviation (936)
 */
const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

const IATA_STATUS_LABELS = {
  BKD: 'Booked', RCS: 'Received from Shipper', MAN: 'Manifested',
  DEP: 'Departed', ARR: 'Arrived', RCF: 'Received from Flight',
  NFD: 'Notified for Delivery', DLV: 'Delivered',
}

async function trackTurkish(prefix, number) {
  const url = 'https://www.turkishcargo.com/api/proxy/onlineServices/shipmentTracking'
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ trackingFilters: [{ shipmentPrefix: prefix, masterDocumentNumber: number }] }),
    signal: AbortSignal.timeout(15000),
  })
  if (!resp.ok) throw new Error(`Turkish API ${resp.status}`)
  const data = await resp.json()
  if (data.status !== 'SUCCESS' || !data.result?.shipmentTrackings?.length) return null

  const shipment = data.result.shipmentTrackings[0]
  const result = {
    flight: null, eta: null, origin: shipment.originCode || null,
    status: null, pieces: shipment.pieces || null, weight: shipment.weight || null,
    uld: null, legs: [],
  }

  const history = shipment.trackingHistoryDetails || []
  for (const h of history) {
    if (!h.status) continue
    result.legs.push({
      station: h.station || '', status: h.status,
      label: IATA_STATUS_LABELS[h.status] || h.description || h.status,
      time: h.actualDatetime || '', flight: h.flightNo || null,
      pieces: h.actualPieces || null, weight: h.actualWeight || null,
    })
  }
  if (result.legs.length > 0) result.status = result.legs[result.legs.length - 1].status

  const flights = shipment.bookingFlightDetails || []
  if (flights.length > 0) {
    const miaFlight = flights.find(f => f.destinationCode === 'MIA') || flights[flights.length - 1]
    result.flight = `${miaFlight.carrierCode}${miaFlight.flightNumber}`
    if (miaFlight.eta) result.eta = miaFlight.eta
  }
  return result
}

async function trackDHL(prefix, number) {
  const url = `https://aviationcargo.dhl.com/track/${prefix}-${number}`
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none',
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!resp.ok) throw new Error(`DHL HTTP ${resp.status}`)
  const html = await resp.text()
  if (html.includes('Request Rejected') || html.includes('No results found') || html.length < 3000) return null

  const result = { flight: null, eta: null, origin: null, status: null, pieces: null, weight: null, uld: null, legs: [] }

  const orgMatch = html.match(/Org\s+(?:<[^>]*>)*\s*([A-Z]{3})/)
  if (orgMatch) result.origin = orgMatch[1]
  const pwMatch = html.match(/for\s+(?:<[^>]*>)*\s*(\d+)\s*(?:<[^>]*>)*\s*pieces\s+@\s+(?:<[^>]*>)*\s*([\d,.]+)\s*(?:<[^>]*>)*\s*KG/i)
  if (pwMatch) { result.pieces = parseInt(pwMatch[1]); result.weight = parseFloat(pwMatch[2].replace(',', '')) }
  const statusMatch = html.match(/Actual\s+status:.*?([A-Z]{3})\s*-\s*/s)
  if (statusMatch) result.status = statusMatch[1]

  const knownCodes = ['BKD','RCS','MAN','DEP','ARR','RCF','NFD','DLV','FFM']
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
    const station = cells.find(c => /^[A-Z]{3}$/.test(c) && c !== code) || ''
    const time = cells.find(c => /^\d{1,2}:\d{2}$/.test(c)) || ''
    let flight = null
    if (code === 'FFM') { const fm = description.match(/movement\s+(\w+)/i); if (fm) flight = fm[1] }
    result.legs.push({ station, status: code, label: IATA_STATUS_LABELS[code] || description, time, flight, pieces, weight: null })
  }

  if (!result.status && result.legs.length > 0) {
    const order = { BKD:0, RCS:1, MAN:2, DEP:3, ARR:4, RCF:5, NFD:6, DLV:7 }
    const meaningful = result.legs.filter(l => order[l.status] !== undefined)
    if (meaningful.length > 0) {
      meaningful.sort((a, b) => (order[a.status]||0) - (order[b.status]||0))
      result.status = meaningful[meaningful.length - 1].status
    }
  }
  if (!result.flight) { const fl = result.legs.find(l => l.flight); if (fl) result.flight = fl.flight }
  return result
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

async function main() {
  const now = new Date().toISOString()
  const log = (msg) => console.log(`[TrackingAgent] ${msg}`)

  const bookingsSnap = await db.collection('airfreight_bookings')
    .where('created_at', '>=', '2026-06-01').get()

  const awbsToTrack = []
  for (const doc of bookingsSnap.docs) {
    const b = doc.data()
    if (b.status === 'cancelled') continue
    if (!b.awb_lines || !Array.isArray(b.awb_lines)) continue
    for (let i = 0; i < b.awb_lines.length; i++) {
      const line = b.awb_lines[i]
      if (line.on_hand === true) continue
      if (line.tracking_status === 'DLV') continue
      const rawAwb = line.awb_number || ''
      if (!rawAwb) continue
      const match = rawAwb.match(/^(\d{3})-(\d{7,8})(?:-([A-Z]))?$/)
      if (!match) continue
      if (match[1] !== '235' && match[1] !== '936') continue
      awbsToTrack.push({ bookingId: doc.id, awbIdx: i, prefix: match[1], number: match[2], fullAwb: rawAwb })
    }
  }

  // Dedup
  const uniqueAwbs = new Map()
  const dupeMap = new Map()
  for (const awb of awbsToTrack) {
    const key = `${awb.prefix}-${awb.number}`
    if (!uniqueAwbs.has(key)) {
      uniqueAwbs.set(key, awb)
      dupeMap.set(key, [{ bookingId: awb.bookingId, awbIdx: awb.awbIdx }])
    } else {
      dupeMap.get(key).push({ bookingId: awb.bookingId, awbIdx: awb.awbIdx })
    }
  }
  const batch = Array.from(uniqueAwbs.values())
  log(`Found ${awbsToTrack.length} AWBs (${batch.length} unique) for Turkish/DHL`)

  if (batch.length === 0) { log('Nothing to track'); process.exit(0) }

  let success = 0, errors = 0, nodata = 0
  for (const awb of batch) {
    try {
      log(`  Tracking ${awb.fullAwb} (${awb.prefix === '235' ? 'Turkish' : 'DHL'})...`)
      const result = awb.prefix === '235'
        ? await trackTurkish(awb.prefix, awb.number)
        : await trackDHL(awb.prefix, awb.number)

      if (!result) { log(`  No data for ${awb.fullAwb}`); nodata++; continue }

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
      log(`  OK: ${result.status} | flight=${result.flight || '?'} | legs=${result.legs.length} (${targets.length} bookings)`)
      success++
    } catch (err) {
      errors++
      log(`  ERROR: ${err.message}`)
    }
    await new Promise(r => setTimeout(r, 1500))
  }

  log(`\nDone: ${success} success, ${nodata} no-data, ${errors} errors`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
