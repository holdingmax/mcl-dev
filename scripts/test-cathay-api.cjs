/**
 * Test Cathay Cargo API endpoints
 */
async function main() {
  const awb = '06930081'
  const prefix = '160'

  // Try 1: GET with query params
  console.log('=== TRY 1: GET with query params ===')
  try {
    const url1 = `https://api.cathaypacific.com/cargo-shipments/v1/tracking?prefix=${prefix}&awb=${awb}`
    const r1 = await fetch(url1, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    })
    console.log(`HTTP: ${r1.status}`)
    const t1 = await r1.text()
    console.log(`Body: ${t1.slice(0, 500)}`)
  } catch (e) { console.log(`Error: ${e.message}`) }

  // Try 2: POST with JSON body
  console.log('\n=== TRY 2: POST with JSON body ===')
  try {
    const url2 = 'https://api.cathaypacific.com/cargo-shipments/v1/tracking'
    const r2 = await fetch(url2, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ prefix, awbNumber: awb }),
      signal: AbortSignal.timeout(10000),
    })
    console.log(`HTTP: ${r2.status}`)
    const t2 = await r2.text()
    console.log(`Body: ${t2.slice(0, 500)}`)
  } catch (e) { console.log(`Error: ${e.message}`) }

  // Try 3: GET with path params
  console.log('\n=== TRY 3: GET with path ===')
  try {
    const url3 = `https://api.cathaypacific.com/cargo-shipments/v1/tracking/${prefix}-${awb}`
    const r3 = await fetch(url3, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    })
    console.log(`HTTP: ${r3.status}`)
    const t3 = await r3.text()
    console.log(`Body: ${t3.slice(0, 500)}`)
  } catch (e) { console.log(`Error: ${e.message}`) }

  // Try 4: milestones endpoint
  console.log('\n=== TRY 4: Milestones GET ===')
  try {
    const url4 = `https://api.cathaypacific.com/cargo-shipments/v1/milestones?prefix=${prefix}&awbNumber=${awb}`
    const r4 = await fetch(url4, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    })
    console.log(`HTTP: ${r4.status}`)
    const t4 = await r4.text()
    console.log(`Body: ${t4.slice(0, 500)}`)
  } catch (e) { console.log(`Error: ${e.message}`) }

  // Try 5: The model.json shows the page embeds data via server-side rendering
  // Check if the HTML page itself contains the tracking data
  console.log('\n=== TRY 5: Page HTML with AWB in URL ===')
  try {
    const url5 = `https://www.cathaycargo.com/en-us/track-and-trace.html?awb=${prefix}-${awb}`
    const r5 = await fetch(url5, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(15000),
    })
    console.log(`HTTP: ${r5.status}`)
    const html = await r5.text()
    console.log(`Length: ${html.length}`)
    // Check if tracking data is embedded
    console.log(`Contains 'INITIAL_STATE': ${html.includes('INITIAL_STATE')}`)
    console.log(`Contains 'Booking': ${html.includes('Booking')}`)
    console.log(`Contains 'CX3174': ${html.includes('CX3174')}`)
    // Look for script with initial state
    const stateMatch = html.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/)
    if (stateMatch) {
      console.log(`Initial state found: ${stateMatch[1].slice(0, 500)}`)
    }
  } catch (e) { console.log(`Error: ${e.message}`) }
}

main().catch(e => { console.error(e); process.exit(1) })
