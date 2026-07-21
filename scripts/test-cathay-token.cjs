async function main() {
  // Step 1: Get public API token
  console.log('=== Step 1: Get API token ===')
  const tokenResp = await fetch('https://www.cathaycargo.com/content/cargo/en-us/home.APIToken.JSON', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
  })
  console.log(`Token HTTP: ${tokenResp.status}`)
  const tokenData = await tokenResp.text()
  console.log(`Token response: ${tokenData.slice(0, 500)}`)

  // Try to parse token
  let token = null
  try {
    const parsed = JSON.parse(tokenData)
    token = parsed.token || parsed.access_token || parsed.apiToken || parsed.api_token
    console.log(`Parsed keys: ${Object.keys(parsed).join(', ')}`)
    if (!token) console.log(`Full parsed: ${JSON.stringify(parsed).slice(0, 300)}`)
  } catch (e) {
    console.log(`Not JSON: ${e.message}`)
  }

  // Step 2: Try the tracking API with token
  if (token) {
    console.log(`\n=== Step 2: Call tracking API with token ===`)
    console.log(`Token: ${token.slice(0, 50)}...`)

    const trackResp = await fetch('https://api.cathaypacific.com/cargo-shipments/v1/tracking?prefix=160&awbNumber=06930081', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    })
    console.log(`Track HTTP: ${trackResp.status}`)
    const trackData = await trackResp.text()
    console.log(`Track response: ${trackData.slice(0, 1000)}`)
  }

  // Step 3: Try the INITIAL_STATE approach - fetch the page with AWB hash
  console.log('\n=== Step 3: Fetch page with AWB in hash/query ===')
  const pageResp = await fetch('https://www.cathaycargo.com/en-us/track-and-trace.html?search=160-06930081', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html',
    },
  })
  const html = await pageResp.text()
  // Extract __INITIAL_STATE__
  const stateMatch = html.match(/<script[^>]*id="__INITIAL_STATE__"[^>]*>([\s\S]*?)<\/script>/)
  if (stateMatch) {
    console.log(`INITIAL_STATE found, length: ${stateMatch[1].length}`)
    try {
      const state = JSON.parse(stateMatch[1])
      console.log(`State keys: ${Object.keys(state).join(', ')}`)
      console.log(`State snippet: ${JSON.stringify(state).slice(0, 1000)}`)
    } catch (e) {
      console.log(`State parse error: ${e.message}`)
      console.log(`State raw: ${stateMatch[1].slice(0, 500)}`)
    }
  } else {
    console.log('No INITIAL_STATE found')
    // Check if tracking data is in the HTML
    console.log(`HTML contains CX3174: ${html.includes('CX3174')}`)
    console.log(`HTML contains 06930081: ${html.includes('06930081')}`)
    console.log(`HTML contains Booking Received: ${html.includes('Booking Received')}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
