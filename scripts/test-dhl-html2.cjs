async function main() {
  const url = 'https://aviationcargo.dhl.com/track/936-02685701'
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  const html = await resp.text()
  console.log(html)
}
main().catch(e => { console.error(e); process.exit(1) })
