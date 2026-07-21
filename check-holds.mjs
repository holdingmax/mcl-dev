import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const config = JSON.parse(readFileSync(join(homedir(), '.config', 'configstore', 'firebase-tools.json'), 'utf8'))
const rt = config.tokens.refresh_token
const res = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type:'refresh_token',refresh_token:rt,client_id:'563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',client_secret:'j9iVZfS8kkCEFUPaAeJV0sAi'})})
const token = (await res.json()).access_token
const BASE = 'https://firestore.googleapis.com/v1/projects/wms-mcl/databases/(default)/documents'

// Search for AWBs 369-99783283 and 369-99783305 in bookings
console.log('=== Searching bookings for AWBs 369-99783283 and 369-99783305 ===\n')

const qr = await fetch(BASE + ':runQuery', {
  method:'POST', headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
  body: JSON.stringify({structuredQuery:{from:[{collectionId:'airfreight_bookings'}],limit:500}})
})
const docs = await qr.json()

let foundBookings = 0
const targetAwbs = ['99783283', '99783305']

for (const d of docs) {
  if (!d.document) continue
  const f = d.document.fields
  const lines = f.awb_lines?.arrayValue?.values || []
  const docId = d.document.name.split('/').pop()

  for (const line of lines) {
    const lf = line.mapValue?.fields || {}
    const awb1 = lf.awb_number?.stringValue || ''
    const awb2 = lf.awb_2nd?.stringValue || ''
    const holdFlag = lf.hold?.booleanValue || false
    const holds = lf.holds?.arrayValue?.values || []

    for (const t of targetAwbs) {
      if (awb1.includes(t) || awb2.includes(t)) {
        console.log(`FOUND in booking ${docId}:`)
        console.log(`  AWB 1st: ${awb1} | 2nd: ${awb2}`)
        console.log(`  hold flag: ${holdFlag} | holds count: ${holds.length}`)
        console.log(`  client: ${f.client_name?.stringValue} | flight: ${f.flight_number?.stringValue}`)
        console.log(`  flight_id: ${f.flight_id?.stringValue}`)
        if (holds.length > 0) {
          for (const h of holds) {
            const hf = h.mapValue?.fields || {}
            console.log(`    hold: bag=${hf.bag?.stringValue} box=${hf.box?.stringValue}`)
          }
        }
        console.log()
        foundBookings++
      }
    }
  }
}

console.log(`Total bookings with matching AWBs: ${foundBookings}`)

// Also check: how many bookings have awb_lines with hold=true but no corresponding airfreight_holds?
console.log('\n=== Bookings with holds in awb_lines (QT4099 flight) ===\n')

// Find QT4099 flight
const flightQ = await fetch(BASE + ':runQuery', {
  method:'POST', headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
  body: JSON.stringify({structuredQuery:{from:[{collectionId:'airfreight_flights'}],where:{fieldFilter:{field:{fieldPath:'flight_number'},op:'EQUAL',value:{stringValue:'QT4099'}}},limit:5}})
})
const flightDocs = await flightQ.json()
for (const fd of flightDocs) {
  if (!fd.document) continue
  const flightId = fd.document.name.split('/').pop()
  console.log('Flight ID:', flightId)

  // Find bookings for this flight
  const bq = await fetch(BASE + ':runQuery', {
    method:'POST', headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body: JSON.stringify({structuredQuery:{from:[{collectionId:'airfreight_bookings'}],where:{fieldFilter:{field:{fieldPath:'flight_id'},op:'EQUAL',value:{stringValue:flightId}}},limit:50}})
  })
  const bDocs = await bq.json()

  let totalHoldsInBookings = 0
  let awbsWithHolds = []

  for (const bd of bDocs) {
    if (!bd.document) continue
    const bf = bd.document.fields
    const bId = bd.document.name.split('/').pop()
    const lines = bf.awb_lines?.arrayValue?.values || []

    for (const line of lines) {
      const lf = line.mapValue?.fields || {}
      const awb1 = lf.awb_number?.stringValue || ''
      const holdFlag = lf.hold?.booleanValue || false
      const holds = lf.holds?.arrayValue?.values || []

      if (holdFlag || holds.length > 0) {
        totalHoldsInBookings++
        const holdDetails = holds.map(h => {
          const hf = h.mapValue?.fields || {}
          return `bag=${hf.bag?.stringValue || '?'} box=${hf.box?.stringValue || '?'}`
        }).join(', ')
        awbsWithHolds.push(`  ${awb1} (booking ${bId}): hold=${holdFlag}, ${holds.length} holds [${holdDetails}]`)
      }
    }
  }

  console.log(`Bookings for QT4099: ${bDocs.filter(d=>d.document).length}`)
  console.log(`AWBs with holds in bookings: ${totalHoldsInBookings}`)
  for (const line of awbsWithHolds) console.log(line)
}

// Check holds collection for QT4099
console.log('\n=== Holds in airfreight_holds collection (all) ===')
const holdsQ = await fetch(BASE + ':runQuery', {
  method:'POST', headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
  body: JSON.stringify({structuredQuery:{from:[{collectionId:'airfreight_holds'}],limit:500}})
})
const holdsDocs = await holdsQ.json()
const holdAwbs = new Set()
for (const hd of holdsDocs) {
  if (!hd.document) continue
  holdAwbs.add(hd.document.fields.awb_number?.stringValue || '')
}
console.log('Total holds in collection:', holdsDocs.filter(d=>d.document).length)
console.log('Unique AWBs in holds collection:', holdAwbs.size)
