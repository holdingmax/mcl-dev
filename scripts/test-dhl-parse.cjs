async function main() {
  const url = 'https://aviationcargo.dhl.com/track/936-02685701'
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    },
  })
  const html = await resp.text()

  // Extract origin
  const orgMatch = html.match(/Org\s+(?:<[^>]*>)*\s*([A-Z]{3})/)
  console.log(`Origin: ${orgMatch ? orgMatch[1] : 'null'}`)

  // Dest
  const destMatch = html.match(/Dest\s+(?:<[^>]*>)*\s*([A-Z]{3})/)
  console.log(`Dest:   ${destMatch ? destMatch[1] : 'null'}`)

  // Pieces/weight
  const pwMatch = html.match(/for\s+(?:<[^>]*>)*\s*(\d+)\s*(?:<[^>]*>)*\s*pieces\s+@\s+(?:<[^>]*>)*\s*([\d,.]+)\s*(?:<[^>]*>)*\s*KG/i)
  console.log(`Pcs/Wt: ${pwMatch ? `${pwMatch[1]} / ${pwMatch[2]}` : 'null'}`)

  // Actual status
  const statusMatch = html.match(/Actual\s+status:.*?([A-Z]{3})\s*-\s*/s)
  console.log(`Status: ${statusMatch ? statusMatch[1] : 'null'}`)

  // Find all table rows - let me see what the actual structure looks like
  // First, let me extract a sample around DLV
  const dlvIdx = html.indexOf('>DLV<')
  if (dlvIdx > 0) {
    console.log('\n=== HTML around DLV ===')
    console.log(html.slice(dlvIdx - 200, dlvIdx + 300))
  }

  // Try extracting around ARR
  const arrIdx = html.indexOf('>ARR<')
  if (arrIdx > 0) {
    console.log('\n=== HTML around ARR ===')
    console.log(html.slice(arrIdx - 200, arrIdx + 300))
  }

  // Try around RCS
  const rcsIdx = html.indexOf('>RCS<')
  if (rcsIdx > 0) {
    console.log('\n=== HTML around RCS ===')
    console.log(html.slice(rcsIdx - 200, rcsIdx + 300))
  }

  // FFM
  const ffmIdx = html.indexOf('>FFM<')
  if (ffmIdx > 0) {
    console.log('\n=== HTML around FFM ===')
    console.log(html.slice(ffmIdx - 100, ffmIdx + 400))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
