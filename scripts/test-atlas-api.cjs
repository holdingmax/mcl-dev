/**
 * Test Atlas Air API parser — validates the new API-based tracking logic
 */

const LABELS = {
  BKD: 'Booked', RCS: 'Received from Shipper', MAN: 'Manifested',
  ULD: 'ULD Assigned', DEP: 'Departed', ARR: 'Arrived',
  RCF: 'Received from Flight', NFD: 'Notified for Delivery', DLV: 'Delivered',
}

async function testAwb(prefix, number) {
  const url = `https://jumpseat.atlasair.com/tracktraceapi/api/FreightContProvdr/GetFriegtDtlByAwbNo?prfx=${prefix}&serial=${number}`
  console.log(`\n=== AWB ${prefix}-${number} ===`)
  console.log(`URL: ${url}`)

  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
  })
  console.log(`HTTP Status: ${resp.status}`)
  const data = await resp.json()

  // Check no-data case
  if (!data.Origin && (!data.LstFrieghtDtlEnhanced || data.LstFrieghtDtlEnhanced.length === 0)) {
    console.log('Result: NULL (no data — would NOT mark as checked)')
    return
  }

  const milestones = data.LstFrieghtDtlEnhanced || []
  const legs = []
  let uld = null

  for (const m of milestones) {
    if (!m.Status) continue
    const flight = (m.Carrier && m.FlightNo) ? `${m.Carrier}${m.FlightNo}` : null
    legs.push({
      station: m.Origin || '',
      status: m.Status,
      label: LABELS[m.Status] || m.Status,
      time: m.DtTime || m.DtTimeStr || '',
      flight,
      pieces: m.Pieces || null,
      weight: m.Weight || null,
    })
    if (m.Status === 'ULD' && m.LstULDDetail && m.LstULDDetail.length > 0) {
      uld = m.LstULDDetail.map(u => u.ULDNumber).join(', ')
    }
  }

  const status = (data.LstStatus && data.LstStatus.length > 0)
    ? data.LstStatus[data.LstStatus.length - 1]
    : (legs.length > 0 ? legs[legs.length - 1].status : null)

  const bkdEntry = milestones.find(m => m.Status === 'BKD' && m.Carrier && m.FlightNo)
  const anyFlight = milestones.find(m => m.Carrier && m.FlightNo)
  const flightEntry = bkdEntry || anyFlight
  const flight = flightEntry ? `${flightEntry.Carrier}${flightEntry.FlightNo}` : null

  const arrEntry = milestones.find(m => m.Status === 'ARR')
  const eta = arrEntry ? (arrEntry.DtTime || arrEntry.DtTimeStr || null) : null

  console.log(`Origin:  ${data.Origin || 'null'}`)
  console.log(`Dest:    ${data.Destination || 'null'}`)
  console.log(`Status:  ${status || 'null'}`)
  console.log(`Flight:  ${flight || 'null'}`)
  console.log(`ETA:     ${eta || 'null'}`)
  console.log(`Pieces:  ${data.Pieces} | Weight: ${data.Weight}`)
  console.log(`ULDs:    ${uld || 'null'}`)
  console.log(`Legs:    ${legs.length}`)
  for (const l of legs) {
    console.log(`  ${l.status.padEnd(4)} | ${l.label.padEnd(25)} | ${l.station} | ${l.time} | flt=${l.flight || '-'}`)
  }
  console.log('Would save to Firestore: YES')
}

async function main() {
  // Test with known AWBs
  await testAwb('369', '98051413')  // completed AWB with all milestones
  await testAwb('369', '10316740')  // AWB with no data yet
}

main().catch(e => { console.error(e); process.exit(1) })
