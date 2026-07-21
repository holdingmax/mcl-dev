/**
 * Test Turkish Cargo API and DHL Aviation Cargo HTML parsing
 */

const IATA_STATUS_LABELS = {
  BKD: 'Booked', RCS: 'Received from Shipper', MAN: 'Manifested',
  DEP: 'Departed', ARR: 'Arrived', RCF: 'Received from Flight',
  NFD: 'Notified for Delivery', DLV: 'Delivered',
}

async function testTurkish(prefix, number) {
  console.log(`\n=== TURKISH CARGO ${prefix}-${number} ===`)
  const url = 'https://www.turkishcargo.com/api/proxy/onlineServices/shipmentTracking'
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ trackingFilters: [{ shipmentPrefix: prefix, masterDocumentNumber: number }] }),
    signal: AbortSignal.timeout(15000),
  })
  console.log(`HTTP: ${resp.status}`)
  if (!resp.ok) { console.log('FAILED'); return }
  const data = await resp.json()

  if (data.status !== 'SUCCESS' || !data.result?.shipmentTrackings?.length) {
    console.log('Result: NULL (no data)')
    return
  }

  const s = data.result.shipmentTrackings[0]
  console.log(`Origin:  ${s.originCode} | Dest: ${s.destinationCode}`)
  console.log(`Pieces:  ${s.pieces} | Weight: ${s.weight}`)
  console.log(`Status:  ${s.actualStatus}`)

  const flights = s.bookingFlightDetails || []
  for (const f of flights) {
    console.log(`Flight:  ${f.carrierCode}${f.flightNumber} ${f.originCode}-${f.destinationCode} ETD=${f.etd} ETA=${f.eta}`)
  }

  const history = s.trackingHistoryDetails || []
  console.log(`Legs:    ${history.length}`)
  for (const h of history) {
    console.log(`  ${(h.status||'').padEnd(4)} | ${(h.description||'').padEnd(35)} | ${h.station} | ${h.actualDatetime} | flt=${h.flightNo || '-'}`)
  }
}

async function testDHL(prefix, number) {
  console.log(`\n=== DHL AVIATION ${prefix}-${number} ===`)
  const url = `https://aviationcargo.dhl.com/track/${prefix}-${number}`
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  })
  console.log(`HTTP: ${resp.status}`)
  if (!resp.ok) { console.log('FAILED'); return }
  const html = await resp.text()

  if (html.includes('No results found') || html.includes('no tracking information')) {
    console.log('Result: NULL (no data)')
    return
  }

  // Origin
  const orgMatch = html.match(/Org\s+<[^>]*>([A-Z]{3})</)
  console.log(`Origin:  ${orgMatch ? orgMatch[1] : 'null'}`)

  // Pieces/weight
  const pwMatch = html.match(/for\s+(\d+)\s+pieces\s+@\s+([\d.]+)\s+KG/i)
  console.log(`Pieces:  ${pwMatch ? pwMatch[1] : 'null'} | Weight: ${pwMatch ? pwMatch[2] : 'null'}`)

  // Status
  const statusMatch = html.match(/Actual status:.*?([A-Z]{3})\s*-/s)
  console.log(`Status:  ${statusMatch ? statusMatch[1] : 'null'}`)

  // Parse rows
  const rowRegex = /<tr[^>]*>\s*<td[^>]*>\s*([A-Z]{2,4})\s*<\/td>\s*<td[^>]*>\s*([^<]+)<\/td>\s*<td[^>]*>\s*(\d+)\s*pcs\s*<\/td>\s*<td[^>]*>\s*([A-Z]{3})\s*<\/td>\s*<td[^>]*>\s*([^<]*)<\/td>\s*<td[^>]*>\s*(\d{1,2}:\d{2})\s*<\/td>/gi
  let match
  const legs = []
  while ((match = rowRegex.exec(html)) !== null) {
    legs.push({ status: match[1], label: match[2].trim(), pieces: match[3], station: match[4], facility: match[5], time: match[6] })
  }
  console.log(`Legs:    ${legs.length}`)
  for (const l of legs) {
    console.log(`  ${l.status.padEnd(4)} | ${l.label.padEnd(40)} | ${l.station} | ${l.time} | ${l.pieces} pcs`)
  }

  if (legs.length === 0) {
    // Fallback: simpler check
    const simpleRegex = />\s*(BKD|RCS|DEP|ARR|RCF|NFD|DLV|MAN|FFM)\s*<\/td>\s*<td[^>]*>\s*([^<]+)/gi
    const simple = []
    while ((match = simpleRegex.exec(html)) !== null) {
      simple.push({ status: match[1], label: match[2].trim() })
    }
    console.log(`Fallback legs: ${simple.length}`)
    for (const l of simple) {
      console.log(`  ${l.status} | ${l.label}`)
    }
  }
}

async function main() {
  // Turkish - known AWB with data
  await testTurkish('235', '96093874')

  // DHL - known AWB with data
  await testDHL('936', '02685701')
}

main().catch(e => { console.error(e); process.exit(1) })
