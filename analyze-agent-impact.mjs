import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
const config = JSON.parse(readFileSync(join(homedir(), '.config', 'configstore', 'firebase-tools.json'), 'utf8'))
const rt = config.tokens.refresh_token
const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: rt,
    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
  }),
})
const data = await res.json()
const token = data.access_token
const BASE = 'https://firestore.googleapis.com/v1/projects/wms-mcl/databases/(default)/documents'
function pv(v) {
  if (!v) return null
  if ('stringValue' in v) return v.stringValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('booleanValue' in v) return v.booleanValue
  if ('mapValue' in v) { const o = {}; for (const [k,val] of Object.entries(v.mapValue.fields||{})) o[k]=pv(val); return o }
  if ('arrayValue' in v) return (v.arrayValue.values||[]).map(pv)
  return v
}

async function getAllDocs(coll) {
  let all = [], npt = null
  do {
    let u = BASE + '/' + coll + '?pageSize=300'
    if (npt) u += '&pageToken=' + npt
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
    const d = await r.json()
    all.push(...(d.documents || []))
    npt = d.nextPageToken
  } while (npt)
  return all
}

// 1. Find all flights created by agent
console.log('=== FLIGHTS CREATED BY AGENT ===')
const flights = await getAllDocs('airfreight_flights')
const agentFlights = []
for (const doc of flights) {
  const f = doc.fields || {}
  const createdBy = pv(f.created_by) || ''
  if (createdBy === 'sheet_sync_agent') {
    const id = doc.name.split('/').pop()
    const fn = pv(f.flight_number) || ''
    const dt = pv(f.flight_datetime) || ''
    const status = pv(f.status) || pv(f.flight_status) || ''
    agentFlights.push({ id, fn, dt, status })
    console.log(`  ${id} | flight_number: "${fn}" | datetime: ${dt} | status: ${status}`)
  }
}

// 2. Find all bookings created by agent
console.log('\n=== BOOKINGS CREATED BY AGENT ===')
const bookings = await getAllDocs('airfreight_bookings')
const agentBookings = []
for (const doc of bookings) {
  const f = doc.fields || {}
  const createdBy = pv(f.created_by) || ''
  if (createdBy === 'sheet_sync_agent') {
    const id = doc.name.split('/').pop()
    const fn = pv(f.flight_number) || ''
    const flightId = pv(f.flight_id) || ''
    const client = pv(f.client_name) || ''
    const lines = pv(f.awb_lines) || []
    agentBookings.push({ id, fn, flightId, client, lines })
    console.log(`  ${id.slice(0,12)} | flight_number: "${fn}" | flight_id: ${flightId.slice(0,12)} | client: ${client} | awbs: ${lines.length}`)
    for (const l of lines) {
      console.log(`    AWB: ${l.awb_number} | 2nd: ${l.awb_2nd_leg || ''} | weight: ${l.weight || 0}`)
    }
  }
}

// 3. Check bookings that reference agent-created flights (even if booking wasn't created by agent)
console.log('\n=== ALL BOOKINGS REFERENCING AGENT-CREATED FLIGHTS ===')
const agentFlightIds = new Set(agentFlights.map(f => f.id))
for (const doc of bookings) {
  const f = doc.fields || {}
  const flightId = pv(f.flight_id) || ''
  if (agentFlightIds.has(flightId)) {
    const id = doc.name.split('/').pop()
    const fn = pv(f.flight_number) || ''
    const createdBy = pv(f.created_by) || ''
    const lines = pv(f.awb_lines) || []
    const agentFlight = agentFlights.find(af => af.id === flightId)
    console.log(`  ${id.slice(0,12)} | booking_flight: "${fn}" | actual_flight: "${agentFlight?.fn}" | by: ${createdBy} | awbs: ${lines.length}`)
  }
}

// 4. Check alerts with wrong flight data
console.log('\n=== ALERTS CREATED WITH WRONG FLIGHT DATA ===')
const alertDocs = await getAllDocs('_sheet_sync_alerts')
for (const doc of alertDocs) {
  const f = doc.fields || {}
  const fn = pv(f.flight_number) || ''
  const alertType = pv(f.alert_type) || ''
  const awb = pv(f.awb_1st) || ''
  const status = pv(f.status) || ''
  // Check if flight_number looks like inbound data (contains ETA, AM/PM, time patterns)
  if (/eta|am|pm|:\d{2}|^\d{1,2}[:\-]\d{2}/i.test(fn) || fn === '' || /^\d{4}\/\d/.test(fn)) {
    console.log(`  ${awb} | flight: "${fn.replace(/\n/g, ' ')}" | type: ${alertType} | status: ${status}`)
  }
}

// 5. Summary
console.log('\n=== SUMMARY ===')
console.log(`Agent-created flights: ${agentFlights.length}`)
console.log(`Agent-created bookings: ${agentBookings.length}`)
const wrongFlights = agentFlights.filter(f => /eta|am|pm|:\d{2}/i.test(f.fn) || !f.fn || f.fn === 'PENDING')
console.log(`Flights with wrong/inbound number: ${wrongFlights.length}`)
for (const wf of wrongFlights) {
  console.log(`  ${wf.id} | "${wf.fn}" | ${wf.dt}`)
}
