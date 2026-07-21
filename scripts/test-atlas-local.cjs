/**
 * Test local del scraper de Atlas Air — browser VISIBLE
 *
 * Replica exactamente la logica del scraper en functions/index.js
 * pero con puppeteer full (no puppeteer-core) y headless:false
 * para poder ver que pasa en pantalla.
 *
 * Uso: node scripts/test-atlas-local.cjs [awb_number]
 * Ejemplo: node scripts/test-atlas-local.cjs 99781990
 * Si no se pasa AWB, usa 99781990 por defecto.
 */

const puppeteer = require('puppeteer')

const PREFIX = '369'
const DEFAULT_NUMBER = '99781990'
const URL = 'https://www.atlasair.com/cargo-services/track-and-trace/'

async function testAtlas(number) {
  console.log(`\n=== TEST ATLAS AIR SCRAPER ===`)
  console.log(`AWB: ${PREFIX}-${number}`)
  console.log(`URL: ${URL}`)
  console.log(`Mode: headless OFF (browser visible)\n`)

  // STEP 1: Launch browser
  console.log('[STEP 1] Launching browser...')
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1280, height: 720 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  console.log('[STEP 1] Browser launched OK\n')

  try {
    // STEP 2: Navigate
    console.log('[STEP 2] Navigating to Atlas Air tracking page...')
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 })
    console.log(`[STEP 2] Page loaded. Final URL: ${page.url()}`)
    const title = await page.title()
    console.log(`[STEP 2] Page title: "${title}"\n`)

    // STEP 3: Analyze inputs on the page
    console.log('[STEP 3] Analyzing page inputs...')
    const inputInfo = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="text"], input:not([type])')
      return Array.from(inputs).map((inp, i) => ({
        index: i,
        tag: inp.tagName,
        type: inp.type,
        name: inp.name || '(none)',
        id: inp.id || '(none)',
        placeholder: inp.placeholder || '(none)',
        value: inp.value || '(empty)',
        visible: inp.offsetParent !== null,
        width: inp.getBoundingClientRect().width,
        height: inp.getBoundingClientRect().height,
      }))
    })
    console.log(`[STEP 3] Found ${inputInfo.length} text inputs:`)
    for (const inp of inputInfo) {
      console.log(`  [${inp.index}] name="${inp.name}" id="${inp.id}" placeholder="${inp.placeholder}" value="${inp.value}" visible=${inp.visible} size=${Math.round(inp.width)}x${Math.round(inp.height)}`)
    }
    console.log()

    // STEP 4: Analyze buttons
    console.log('[STEP 4] Analyzing buttons...')
    const buttonInfo = await page.evaluate(() => {
      const btns = document.querySelectorAll('button, input[type="submit"], a[class*="btn"], span[class*="submit"], div[class*="submit"]')
      return Array.from(btns).map((btn, i) => ({
        index: i,
        tag: btn.tagName,
        text: btn.textContent.trim().slice(0, 60),
        className: (btn.className || '').toString().slice(0, 80),
        visible: btn.offsetParent !== null,
        width: btn.getBoundingClientRect().width,
      }))
    })
    console.log(`[STEP 4] Found ${buttonInfo.length} buttons/submit elements:`)
    for (const btn of buttonInfo) {
      console.log(`  [${btn.index}] <${btn.tag}> text="${btn.text}" class="${btn.className}" visible=${btn.visible} width=${Math.round(btn.width)}`)
    }
    console.log()

    // STEP 5: Fill form (exact same logic as the agent)
    console.log('[STEP 5] Filling form...')
    const inputs = await page.$$('input[type="text"], input:not([type])')
    let filledPrefix = false, filledNumber = false
    for (const inp of inputs) {
      const rect = await inp.boundingBox()
      if (!rect || rect.width < 20) continue
      const name = await inp.evaluate(el => (el.name || el.id || el.placeholder || '').toLowerCase())
      if (!filledPrefix && (name.includes('pe') || name.includes('prefix') || name.includes('awb'))) {
        await inp.click({ clickCount: 3 })
        await inp.type(PREFIX, { delay: 30 })
        filledPrefix = true
        console.log(`  Filled prefix input (name match: "${name}") with "${PREFIX}"`)
      } else if (filledPrefix && !filledNumber) {
        await inp.click({ clickCount: 3 })
        await inp.type(number, { delay: 30 })
        filledNumber = true
        console.log(`  Filled number input (name: "${name}") with "${number}"`)
      }
    }
    // Fallback: try first two visible inputs
    if (!filledPrefix) {
      console.log('  Named inputs not found. Trying first two visible inputs...')
      const allInputs = await page.$$('input')
      let count = 0
      for (const inp of allInputs) {
        const rect = await inp.boundingBox()
        if (!rect || rect.width < 20 || rect.height < 10) continue
        const type = await inp.evaluate(el => el.type)
        if (type === 'hidden' || type === 'checkbox' || type === 'radio') continue
        if (count === 0) {
          await inp.click({ clickCount: 3 }); await inp.type(PREFIX, { delay: 30 })
          console.log(`  Filled input[${count}] with prefix "${PREFIX}"`)
        } else if (count === 1) {
          await inp.click({ clickCount: 3 }); await inp.type(number, { delay: 30 })
          console.log(`  Filled input[${count}] with number "${number}"`)
        }
        count++
        if (count >= 2) break
      }
      if (count < 2) console.log(`  WARNING: Only found ${count} fillable inputs`)
    }
    console.log(`  Result: filledPrefix=${filledPrefix} filledNumber=${filledNumber}\n`)

    // STEP 6: Click submit
    console.log('[STEP 6] Looking for submit button...')
    const btns = await page.$$('button, input[type="submit"], a[class*="btn"], span[class*="submit"], div[class*="submit"]')
    let clicked = false
    for (const btn of btns) {
      const rect = await btn.boundingBox()
      if (!rect) continue
      const t = await btn.evaluate(el => el.textContent.trim().toLowerCase() + ' ' + (el.className || ''))
      if (t.includes('track') || t.includes('submit') || t.includes('search') || t.includes('arrow') || rect.width < 60) {
        await btn.click()
        clicked = true
        console.log(`  Clicked button: "${t.slice(0, 80)}"`)
        break
      }
    }
    if (!clicked) console.log('  WARNING: No submit button found/clicked')

    // Also press Enter
    await page.keyboard.press('Enter')
    console.log('  Pressed Enter\n')

    // STEP 7: Wait for results
    console.log('[STEP 7] Waiting for results (max 15s)...')
    const waitResult = await page.waitForFunction(() => {
      return document.body.innerText.includes('Air Waybill') ||
             document.body.innerText.includes('Status Information') ||
             document.querySelectorAll('table').length > 1
    }, { timeout: 15000 }).then(() => 'found').catch(() => 'timeout')
    console.log(`[STEP 7] Wait result: ${waitResult}`)
    await new Promise(r => setTimeout(r, 2000))
    console.log()

    // STEP 8: Capture page state
    console.log('[STEP 8] Capturing page state after submit...')
    const pageState = await page.evaluate(() => {
      const tables = document.querySelectorAll('table')
      const tableInfo = Array.from(tables).map((t, i) => {
        const headers = Array.from(t.querySelectorAll('th')).map(th => th.textContent.trim())
        const rowCount = t.querySelectorAll('tr').length
        return { index: i, headers, rowCount }
      })
      return {
        url: window.location.href,
        bodyLength: document.body.innerText.length,
        snippet: document.body.innerText.slice(0, 800),
        tableCount: tables.length,
        tables: tableInfo,
      }
    })
    console.log(`  URL: ${pageState.url}`)
    console.log(`  Body text length: ${pageState.bodyLength}`)
    console.log(`  Tables found: ${pageState.tableCount}`)
    for (const t of pageState.tables) {
      console.log(`    Table[${t.index}]: ${t.rowCount} rows, headers: [${t.headers.join(', ')}]`)
    }
    console.log(`  Page snippet (first 800 chars):`)
    console.log(`  ---`)
    console.log(`  ${pageState.snippet.replace(/\n{3,}/g, '\n\n')}`)
    console.log(`  ---\n`)

    // STEP 9: Run the actual parser (same as agent)
    console.log('[STEP 9] Running parser (same logic as agent)...')
    const result = await page.evaluate(() => {
      const result = { flight: null, eta: null, origin: null, status: null, pieces: null, weight: null, uld: null, legs: [] }
      const tables = document.querySelectorAll('table')
      for (const table of tables) {
        const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim())
        if (headers.includes('Flight No') || headers.includes('Flight No.')) {
          const row = table.querySelector('tbody tr') || table.querySelectorAll('tr')[1]
          if (row) {
            const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim())
            const flightIdx = headers.findIndex(h => h.includes('Flight'))
            const routeIdx = headers.findIndex(h => h.includes('Route'))
            if (flightIdx >= 0) result.flight = cells[flightIdx] || null
            if (routeIdx >= 0) {
              const route = cells[routeIdx] || ''
              const parts = route.split('-')
              if (parts.length >= 1) result.origin = parts[0].trim()
            }
          }
        }
        if (headers.includes('Status') && headers.includes('Event Time')) {
          const stIdx = headers.findIndex(h => h === 'Status')
          const evIdx = headers.findIndex(h => h.includes('Event Time'))
          const stnIdx = headers.findIndex(h => h.includes('Station'))
          const descIdx = headers.findIndex(h => h.includes('Description'))
          const pcsIdx = headers.findIndex(h => h.includes('Pieces'))
          const wtIdx = headers.findIndex(h => h.includes('Weight'))
          const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)')
          for (const r of rows) {
            const cells = Array.from(r.querySelectorAll('td')).map(td => td.textContent.trim())
            if (cells.length < 3) continue
            const rawStatus = cells[stIdx] || ''
            const codeMatch = rawStatus.match(/\((\w+)\)/)
            const code = codeMatch ? codeMatch[1] : rawStatus.split(' ')[0]
            const label = rawStatus.replace(/\(\w+\)\s*/, '').trim()
            const leg = {
              station: stnIdx >= 0 ? cells[stnIdx] : '',
              status: code,
              label: label || code,
              time: evIdx >= 0 ? cells[evIdx] : '',
              pieces: pcsIdx >= 0 ? parseInt(cells[pcsIdx]) || null : null,
              weight: wtIdx >= 0 ? parseFloat(cells[wtIdx]) || null : null,
            }
            if (descIdx >= 0) {
              const desc = cells[descIdx] || ''
              const fltMatch = desc.match(/(\w{2}\d{3,4})/)
              if (fltMatch) leg.flight = fltMatch[1]
            }
            result.legs.push(leg)
          }
        }
      }
      if (result.legs.length > 0) {
        const order = { BKD:0, RCS:1, DEP:2, ARR:3, RCF:4, NFD:5, DLV:6 }
        result.legs.sort((a, b) => (order[a.status]||0) - (order[b.status]||0))
        result.status = result.legs[result.legs.length - 1].status
        const arrLeg = result.legs.find(l => l.status === 'ARR')
        if (arrLeg && arrLeg.time) result.eta = arrLeg.time
      }
      return result
    })

    console.log('\n=== PARSER RESULT ===')
    console.log(`  Status: ${result.status || '(none)'}`)
    console.log(`  Flight: ${result.flight || '(none)'}`)
    console.log(`  ETA:    ${result.eta || '(none)'}`)
    console.log(`  Origin: ${result.origin || '(none)'}`)
    console.log(`  Pieces: ${result.pieces || '(none)'}`)
    console.log(`  Weight: ${result.weight || '(none)'}`)
    console.log(`  Legs:   ${result.legs.length}`)
    if (result.legs.length > 0) {
      for (const leg of result.legs) {
        console.log(`    ${leg.status} | ${leg.label} | station=${leg.station} | time=${leg.time} | flight=${leg.flight || '-'} | pcs=${leg.pieces || '-'}`)
      }
    }

    const wouldSave = !!(result.status || result.legs.length > 0)
    console.log(`\n  Would save to Firestore: ${wouldSave ? 'YES' : 'NO (No data branch)'}`)

    // STEP 10: Take screenshot
    console.log('\n[STEP 10] Taking screenshot...')
    await page.screenshot({ path: 'scripts/atlas-test-result.png', fullPage: true })
    console.log('  Saved: scripts/atlas-test-result.png')

    // Keep browser open for 30s so user can inspect
    console.log('\n[DONE] Browser stays open for 30s for inspection. Close manually or wait.')
    await new Promise(r => setTimeout(r, 30000))

  } catch (err) {
    console.error(`\n[FATAL ERROR] ${err.message}`)
    console.error(err.stack)
    // Take screenshot on error
    try {
      await page.screenshot({ path: 'scripts/atlas-test-error.png', fullPage: true })
      console.log('  Error screenshot saved: scripts/atlas-test-error.png')
    } catch (_) {}
    await new Promise(r => setTimeout(r, 15000))
  } finally {
    await browser.close()
    console.log('Browser closed.')
  }
}

const awbNumber = process.argv[2] || DEFAULT_NUMBER
testAtlas(awbNumber)
