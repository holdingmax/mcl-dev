/**
 * Run the tracking agent logic directly (same as Cloud Function but local)
 * Uses the real Firestore and real Atlas API
 */

const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

const IATA_STATUS_LABELS = {
  BKD: 'Booked', RCS: 'Received from Shipper', MAN: 'Manifested',
  ULD: 'ULD Assigned', DEP: 'Departed', ARR: 'Arrived',
  RCF: 'Received from Flight', NFD: 'Notified for Delivery', DLV: 'Delivered',
}

async function trackAtlas(prefix, number) {
  const url = `https://jumpseat.atlasair.com/tracktraceapi/api/FreightContProvdr/GetFriegtDtlByAwbNo?prfx=${prefix}&serial=${number}`
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  })
  if (!resp.ok) throw new Error(`Atlas API ${resp.status}`)
  const data = await resp.json()

  if (!data.Origin && (!data.LstFrieghtDtlEnhanced || data.LstFrieghtDtlEnhanced.length === 0)) {
    return null
  }

  const result = {
    flight: null, eta: null, origin: data.Origin || null,
    status: null, pieces: data.Pieces || null, weight: data.Weight || null,
    uld: null, legs: [],
  }

  const milestones = data.LstFrieghtDtlEnhanced || []
  for (const m of milestones) {
    if (!m.Status) continue
    const status = m.Status === 'ULD' ? 'DEP' : m.Status
    const flight = (m.Carrier && m.FlightNo) ? `${m.Carrier}${m.FlightNo}` : null
    result.legs.push({
      station: m.Origin || '', status,
      label: IATA_STATUS_LABELS[status] || status,
      time: m.DtTime || m.DtTimeStr || '', flight,
      pieces: m.Pieces || null, weight: m.Weight || null,
    })
    if (m.Status === 'ULD' && m.LstULDDetail && m.LstULDDetail.length > 0) {
      result.uld = m.LstULDDetail.map(u => u.ULDNumber).join(', ')
    }
  }

  if (data.LstStatus && data.LstStatus.length > 0) {
    const lastStatus = data.LstStatus[data.LstStatus.length - 1]
    result.status = lastStatus === 'ULD' ? 'DEP' : lastStatus
  } else if (result.legs.length > 0) {
    result.status = result.legs[result.legs.length - 1].status
  }

  const bkdEntry = milestones.find(m => m.Status === 'BKD' && m.Carrier && m.FlightNo)
  const anyFlight = milestones.find(m => m.Carrier && m.FlightNo)
  const flightEntry = bkdEntry || anyFlight
  if (flightEntry) result.flight = `${flightEntry.Carrier}${flightEntry.FlightNo}`

  const arrEntry = milestones.find(m => m.Status === 'ARR')
  if (arrEntry) result.eta = arrEntry.DtTime || arrEntry.DtTimeStr || null

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

  // Query eligible AWBs
  const today = new Date()
  const dayMinus1 = new Date(today); dayMinus1.setDate(today.getDate() - 1)
  const dayPlus3 = new Date(today); dayPlus3.setDate(today.getDate() + 3)
  const fromDate = dayMinus1.toISOString().slice(0, 10)
  const toDate = dayPlus3.toISOString().slice(0, 10)
  log(`Date range: ${fromDate} to ${toDate}`)

  const lookback = '2026-06-15'
  const bookingsSnap = await db.collection('airfreight_bookings')
    .where('created_at', '>=', lookback).get()
  log(`Lookback from: ${lookback}`)

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
      if (!match || match[1] !== '369') continue // Only Atlas for this test
      // Force run: skip date range filter to reprocess all
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
  log(`Found ${awbsToTrack.length} AWBs (${batch.length} unique) to track`)

  if (batch.length === 0) { log('Nothing to track'); process.exit(0) }

  // Force run: process all
  const testBatch = batch
  log(`Processing all ${testBatch.length} AWBs...`)

  let success = 0, errors = 0
  for (const awb of testBatch) {
    try {
      log(`  Tracking ${awb.fullAwb}...`)
      const result = await trackAtlas(awb.prefix, awb.number)
      if (!result) {
        log(`  No data for ${awb.fullAwb}`)
        continue
      }
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
    await new Promise(r => setTimeout(r, 1000))
  }

  log(`\nDone: ${success} success, ${errors} errors`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
