const IATA_STATUS_LABELS = {
  BKD: 'Booked', RCS: 'Received from Shipper', MAN: 'Manifested',
  DEP: 'Departed', ARR: 'Arrived', RCF: 'Received from Flight',
  NFD: 'Notified for Delivery', DLV: 'Delivered',
}

async function main() {
  const url = 'https://aviationcargo.dhl.com/track/936-02685701'
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    },
  })
  const html = await resp.text()

  // Parse using stripped table rows
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let m
  const legs = []
  while ((m = trRegex.exec(html)) !== null) {
    const row = m[1].replace(/<[^>]+>/g, '|').replace(/\s+/g, ' ').trim()
    // Split by | and clean
    const cells = row.split('|').map(c => c.trim()).filter(c => c.length > 0)
    if (cells.length < 4) continue

    // Check if first cell is a known status code
    const code = cells[0]
    if (!/^[A-Z]{2,4}$/.test(code)) continue
    const knownCodes = ['BKD','RCS','MAN','DEP','ARR','RCF','NFD','DLV','FFM']
    if (!knownCodes.includes(code)) continue

    const description = cells[1] || ''
    const pcsMatch = cells.find(c => c.includes('pcs'))
    const pieces = pcsMatch ? parseInt(pcsMatch) : null
    const station = cells.find(c => /^[A-Z]{3}$/.test(c)) || ''
    const timeMatch = cells.find(c => /^\d{1,2}:\d{2}$/.test(c))
    const time = timeMatch || ''

    let flight = null
    if (code === 'FFM') {
      const fltMatch = description.match(/movement\s+(\w+)/i)
      if (fltMatch) flight = fltMatch[1]
    }

    legs.push({ status: code, label: IATA_STATUS_LABELS[code] || description, station, time, pieces, flight })
  }

  console.log(`Legs: ${legs.length}`)
  for (const l of legs) {
    console.log(`  ${l.status.padEnd(4)} | ${l.label.padEnd(30)} | ${l.station} | ${l.time} | pcs=${l.pieces} | flt=${l.flight || '-'}`)
  }

  // Overall status
  const orgMatch = html.match(/Org\s+(?:<[^>]*>)*\s*([A-Z]{3})/)
  const pwMatch = html.match(/for\s+(?:<[^>]*>)*\s*(\d+)\s*(?:<[^>]*>)*\s*pieces\s+@\s+(?:<[^>]*>)*\s*([\d,.]+)\s*(?:<[^>]*>)*\s*KG/i)
  const statusMatch = html.match(/Actual\s+status:.*?([A-Z]{3})\s*-\s*/s)

  console.log(`\nOrigin: ${orgMatch ? orgMatch[1] : 'null'}`)
  console.log(`Pieces: ${pwMatch ? pwMatch[1] : 'null'} | Weight: ${pwMatch ? pwMatch[2] : 'null'}`)
  console.log(`Status: ${statusMatch ? statusMatch[1] : 'null'}`)

  // Flight
  const ffmLeg = legs.find(l => l.flight)
  console.log(`Flight: ${ffmLeg ? ffmLeg.flight : 'null'}`)
}

main().catch(e => { console.error(e); process.exit(1) })
