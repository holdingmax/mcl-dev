async function main() {
  const url = 'https://aviationcargo.dhl.com/track/936-02685701'

  // Try with more realistic browser headers
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    },
  })
  console.log(`HTTP: ${resp.status}`)
  const html = await resp.text()
  console.log(`Length: ${html.length}`)
  console.log(`Contains 'DLV': ${html.includes('DLV')}`)
  console.log(`Contains 'WAF': ${html.includes('WAF')}`)
  console.log(`First 500 chars:`)
  console.log(html.slice(0, 500))
}
main().catch(e => { console.error(e); process.exit(1) })
