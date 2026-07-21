/**
 * Fetch DHL HTML and dump relevant sections for analysis
 */
async function main() {
  const url = 'https://aviationcargo.dhl.com/track/936-02685701'
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  console.log(`HTTP: ${resp.status}`)
  const html = await resp.text()
  console.log(`HTML length: ${html.length}`)

  // Find the tracking results section
  const startIdx = html.indexOf('tracking results')
  if (startIdx > 0) {
    console.log('\n=== FROM "tracking results" ===')
    console.log(html.slice(Math.max(0, startIdx - 100), startIdx + 2000))
  }

  // Find table rows with status codes
  const tableIdx = html.indexOf('<table')
  if (tableIdx > 0) {
    console.log('\n=== FIRST TABLE ===')
    const tableEnd = html.indexOf('</table>', tableIdx)
    console.log(html.slice(tableIdx, tableEnd + 10))
  }

  // Find "Actual status"
  const statusIdx = html.indexOf('Actual status')
  if (statusIdx > 0) {
    console.log('\n=== ACTUAL STATUS AREA ===')
    console.log(html.slice(statusIdx - 50, statusIdx + 200))
  }

  // Find origin/dest
  const orgIdx = html.indexOf('Org')
  if (orgIdx > 0) {
    console.log('\n=== ORIGIN AREA ===')
    console.log(html.slice(orgIdx - 20, orgIdx + 200))
  }

  // Find pieces
  const pcsIdx = html.indexOf('pieces')
  if (pcsIdx > 0) {
    console.log('\n=== PIECES AREA ===')
    console.log(html.slice(pcsIdx - 80, pcsIdx + 100))
  }

  // Find DLV/ARR/NFD
  const dlvIdx = html.indexOf('DLV')
  if (dlvIdx > 0) {
    console.log('\n=== DLV AREA (first 500 chars) ===')
    console.log(html.slice(dlvIdx - 50, dlvIdx + 500))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
