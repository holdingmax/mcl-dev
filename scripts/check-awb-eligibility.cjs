/**
 * Check why a specific AWB is not eligible for tracking
 */
const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  const search = '936-00477643'
  console.log(`Searching for AWB containing: ${search}\n`)

  const snap = await db.collection('airfreight_bookings').get()
  let found = false

  for (const doc of snap.docs) {
    const b = doc.data()
    if (!b.awb_lines || !Array.isArray(b.awb_lines)) continue
    for (let i = 0; i < b.awb_lines.length; i++) {
      const line = b.awb_lines[i]
      const awb = line.awb_number || ''
      if (!awb.includes('00477643') && !awb.includes('0477643')) continue

      found = true
      console.log(`=== FOUND in booking ${doc.id}, awb_lines[${i}] ===`)
      console.log(`  awb_number:      ${awb}`)
      console.log(`  on_hand:         ${line.on_hand}`)
      console.log(`  tracking_status: ${line.tracking_status || '(none)'}`)
      console.log(`  tracking_last:   ${line.tracking_last_checked || '(never)'}`)
      console.log(`  last_day_free:   ${line.last_day_free || '(none)'}`)
      console.log(`  ready_for_pickup:${line.ready_for_pickup || '(none)'}`)
      console.log(`  booking status:  ${b.status}`)
      console.log(`  booking created: ${b.created_at}`)

      // Check each filter
      const reasons = []
      if (b.status === 'cancelled') reasons.push('booking is cancelled')
      if (line.on_hand === true) reasons.push('on_hand === true')
      if (line.tracking_status === 'DLV') reasons.push('tracking_status === DLV')

      const match = awb.match(/^(\d{3})-(\d{7,8})(?:-([A-Z]))?$/)
      if (!match) reasons.push(`AWB format doesn't match regex: ${awb}`)
      else {
        const prefix = match[1]
        if (prefix !== '235' && prefix !== '936') reasons.push(`prefix ${prefix} was not in Turkish/DHL filter`)
        console.log(`  parsed prefix:   ${match[1]}`)
        console.log(`  parsed number:   ${match[2]}`)
      }

      if (b.created_at < '2026-06-01') reasons.push(`created_at (${b.created_at}) < 2026-06-01`)

      if (reasons.length > 0) {
        console.log(`\n  EXCLUDED BECAUSE:`)
        for (const r of reasons) console.log(`    - ${r}`)
      } else {
        console.log(`\n  SHOULD BE ELIGIBLE (no exclusion reason found)`)
      }
      console.log()
    }
  }

  if (!found) console.log('AWB not found in any booking')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
