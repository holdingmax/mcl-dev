const fs = require('fs')
const path = require('path')
const https = require('https')

const PROJECT_ID = 'wms-mcl'
const CLIENT_ID = 'YPATo6B9BvRJEIJO7ld9'

function exchangeRefreshToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const postData = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi`
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        const parsed = JSON.parse(data)
        if (parsed.access_token) resolve(parsed.access_token)
        else reject(new Error(parsed.error_description || parsed.error || 'Token exchange failed'))
      })
    })
    req.on('error', reject)
    req.write(postData)
    req.end()
  })
}

function httpReq(token, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null
    const options = {
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents${urlPath}`,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
    if (postData) options.headers['Content-Length'] = Buffer.byteLength(postData)
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) reject(new Error(parsed.error.message))
          else resolve(parsed)
        } catch { reject(new Error('Bad response: ' + data.slice(0, 200))) }
      })
    })
    req.on('error', reject)
    if (postData) req.write(postData)
    req.end()
  })
}

function runQuery(token, collection, filters) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: filters.length === 1
        ? filters[0]
        : { compositeFilter: { op: 'AND', filters } },
    },
  }
  return httpReq(token, 'POST', ':runQuery', body)
}

function getDoc(token, docPath) {
  return httpReq(token, 'GET', `/${docPath}`, null)
}

function parseValue(val) {
  if (!val) return null
  if ('stringValue' in val) return val.stringValue
  if ('integerValue' in val) return Number(val.integerValue)
  if ('doubleValue' in val) return val.doubleValue
  if ('booleanValue' in val) return val.booleanValue
  if ('nullValue' in val) return null
  if ('timestampValue' in val) return val.timestampValue
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(parseValue)
  if ('mapValue' in val) {
    const obj = {}
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) obj[k] = parseValue(v)
    return obj
  }
  return null
}

function parseDoc(doc) {
  const id = (doc.name || '').split('/').pop()
  const fields = {}
  for (const [k, v] of Object.entries(doc.fields || {})) fields[k] = parseValue(v)
  return { id, ...fields }
}

async function main() {
  // Get refresh token from Firebase CLI config
  const home = process.env.USERPROFILE || process.env.HOME
  const cfgPath = path.join(home, '.config', 'configstore', 'firebase-tools.json')
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  const refreshToken = cfg.tokens && cfg.tokens.refresh_token
  if (!refreshToken) { console.error('No refresh token found'); process.exit(1) }

  console.log('Exchanging refresh token...')
  const accessToken = await exchangeRefreshToken(refreshToken)
  console.log('Got access token')

  // 1. Query bookings
  console.log('Querying bookings...')
  const bookingsRaw = await runQuery(accessToken, 'airfreight_bookings', [
    { fieldFilter: { field: { fieldPath: 'client_id' }, op: 'EQUAL', value: { stringValue: CLIENT_ID } } },
    { fieldFilter: { field: { fieldPath: 'booking_type' }, op: 'EQUAL', value: { stringValue: 'ecommerce' } } },
  ])
  const bookings = (Array.isArray(bookingsRaw) ? bookingsRaw : [bookingsRaw])
    .filter(r => r.document)
    .map(r => parseDoc(r.document))
  console.log(`Found ${bookings.length} bookings`)

  // 2. Get flights
  const flightIds = [...new Set(bookings.map(b => b.flight_id).filter(Boolean))]
  console.log(`Fetching ${flightIds.length} flights...`)
  const flights = {}
  for (const fid of flightIds) {
    try {
      const fDoc = await getDoc(accessToken, `airfreight_flights/${fid}`)
      if (fDoc.fields) flights[fid] = { id: fid, ...parseDoc(fDoc) }
    } catch (e) { console.warn(`  Flight ${fid}: ${e.message}`) }
  }
  console.log(`Fetched ${Object.keys(flights).length} flights`)

  // 3. Doc receptions (batch by booking)
  console.log('Fetching doc receptions...')
  const docReceptions = {}
  for (const b of bookings) {
    try {
      const drRaw = await runQuery(accessToken, 'airfreight_doc_receptions', [
        { fieldFilter: { field: { fieldPath: 'booking_id' }, op: 'EQUAL', value: { stringValue: b.id } } },
      ])
      const drs = (Array.isArray(drRaw) ? drRaw : [drRaw]).filter(r => r.document).map(r => parseDoc(r.document))
      for (const dr of drs) {
        const awb = (dr.awb_2nd_leg || dr.awb_number || '').toUpperCase().trim()
        if (awb) docReceptions[awb] = { status: dr.status, created_at: dr.created_at }
      }
    } catch {}
  }
  console.log(`Found ${Object.keys(docReceptions).length} doc receptions`)

  // 4. Build export
  const exportData = {
    client_id: CLIENT_ID,
    exported_at: new Date().toISOString(),
    flights: Object.values(flights).map(f => ({
      id: f.id, flight_number: f.flight_number, airline: f.airline,
      flight_datetime: f.flight_datetime, cutoff_datetime: f.cutoff_datetime,
      destinations: f.destinations || [], status: f.status, created_by: f.created_by,
    })),
    bookings: bookings.map(b => {
      const fl = flights[b.flight_id] || {}
      return {
        id: b.id, flight_id: b.flight_id,
        flight_number: fl.flight_number || b.flight_number,
        airline: fl.airline || b.airline,
        flight_datetime: fl.flight_datetime,
        cutoff_datetime: fl.cutoff_datetime,
        flight_status: fl.status,
        destination_id: b.destination_id, status: b.status,
        pieces: b.pieces, created_by: b.created_by, created_at: b.created_at,
        awb_lines: (b.awb_lines || []).map(l => ({
          awb_number: l.awb_number, awb_2nd_leg: l.awb_2nd_leg,
          pieces: l.pieces || 0, chargeable_weight: l.chargeable_weight || 0,
          uld_type: l.uld_type, pickup_from: l.pickup_from,
          ready_for_pickup: l.ready_for_pickup, last_day_free: l.last_day_free,
          hold: l.hold, holds: l.holds || [], battery: l.battery || false,
          docs_in_drive: l.docs_in_drive || false,
          on_hand: l.on_hand || false, dispatched: l.dispatched || false,
        })),
      }
    }),
  }

  const outPath = path.join(__dirname, '..', 'express-line-export.json')
  fs.writeFileSync(outPath, JSON.stringify(exportData, null, 2))
  const totalAwbs = exportData.bookings.reduce((s, b) => s + b.awb_lines.length, 0)
  console.log(`\nDone! ${outPath}`)
  console.log(`  ${exportData.flights.length} flights, ${exportData.bookings.length} bookings, ${totalAwbs} AWB lines`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
