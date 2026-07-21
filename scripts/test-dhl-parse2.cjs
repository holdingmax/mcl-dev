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

  // Find all occurrences of DLV, ARR, NFD, DEP, RCS, FFM in the HTML
  const codes = ['DLV', 'ARR', 'NFD', 'DEP', 'RCS', 'FFM', 'BKD', 'RCF']
  for (const code of codes) {
    let idx = -1
    while ((idx = html.indexOf(code, idx + 1)) !== -1) {
      // Show context
      const ctx = html.slice(Math.max(0, idx - 30), idx + 80).replace(/\n/g, ' ')
      console.log(`[${code}] at ${idx}: ...${ctx}...`)
    }
  }

  // Also let's find all <tr> tags and their content
  console.log('\n=== TABLE ROWS ===')
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let m
  let count = 0
  while ((m = trRegex.exec(html)) !== null) {
    const row = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (row.length > 5 && row.length < 300) {
      console.log(`TR[${count}]: ${row}`)
    }
    count++
  }
}

main().catch(e => { console.error(e); process.exit(1) })
