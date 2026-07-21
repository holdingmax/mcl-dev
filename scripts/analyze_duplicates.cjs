const data = require('C:\\Users\\dgarc\\Downloads\\billing_duplicates_raw.json')

// Group duplicates
const groups = {}
for (const d of data.duplicates) {
  const key = d.dup_group
  if (!groups[key]) groups[key] = []
  groups[key].push(d)
}

// Show first 5 groups with details
let count = 0
for (const [key, items] of Object.entries(groups)) {
  if (count >= 5) break
  console.log('='.repeat(80))
  console.log('GROUP:', key)
  console.log('Count:', items.length)
  for (const i of items) {
    console.log('  ID:', i.charge_id)
    console.log('    flight:', i.flight_number, '|', i.flight_id)
    console.log('    booking:', i.booking_id, '| type:', i.booking_type)
    console.log('    client:', i.client_name)
    console.log('    charge:', i.charge_name, '| source:', i.source, '| status:', i.status)
    console.log('    qty:', i.qty, '| rate:', i.rate, '| total:', i.total)
    console.log('    created_at:', i.created_at, '| by:', i.created_by)
    console.log('    invoice_id:', i.invoice_id || '(none)')
    console.log()
  }
  count++
}

// Analyze patterns: same created_at? same created_by? time diff?
console.log('\n' + '='.repeat(80))
console.log('PATTERN ANALYSIS')
console.log('='.repeat(80))

for (const [key, items] of Object.entries(groups)) {
  if (items.length < 2) continue
  const times = items.map(i => new Date(i.created_at).getTime()).sort()
  const diffMs = times[times.length - 1] - times[0]
  const sameCreator = items.every(i => i.created_by === items[0].created_by)
  const sameStatus = items.every(i => i.status === items[0].status)
  const invoiced = items.filter(i => i.invoice_id).length

  console.log(`${key}:`)
  console.log(`  Records: ${items.length} | Time spread: ${diffMs}ms (${(diffMs / 1000).toFixed(1)}s)`)
  console.log(`  Same creator: ${sameCreator} (${items[0].created_by})`)
  console.log(`  Same status: ${sameStatus} (${items.map(i => i.status).join(', ')})`)
  console.log(`  Invoiced: ${invoiced}/${items.length}`)
  console.log(`  Created times: ${items.map(i => i.created_at).join(' | ')}`)
  console.log()
}

// Summary: how many are invoiced vs pending?
const invoicedDups = data.duplicates.filter(d => d.status === 'invoiced')
const pendingDups = data.duplicates.filter(d => d.status === 'pending')
const withInvoice = data.duplicates.filter(d => d.invoice_id)

console.log('='.repeat(80))
console.log('RISK ASSESSMENT')
console.log('='.repeat(80))
console.log(`Total duplicate records: ${data.duplicates.length}`)
console.log(`  Invoiced duplicates: ${invoicedDups.length}`)
console.log(`  Pending duplicates: ${pendingDups.length}`)
console.log(`  With invoice_id (already billed): ${withInvoice.length}`)
console.log()

// For each group, identify which record to KEEP and which to DELETE
console.log('CLEANUP PLAN:')
for (const [key, items] of Object.entries(groups)) {
  if (items.length < 2) continue
  // Keep the oldest one (first created), delete the rest
  const sorted = [...items].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
  const keep = sorted[0]
  const toDelete = sorted.slice(1)

  for (const del of toDelete) {
    const safe = !del.invoice_id
    console.log(`  ${safe ? 'SAFE' : 'RISKY'} DELETE: ${del.charge_id} (${del.charge_name}, ${del.status}, invoice: ${del.invoice_id || 'none'}, total: $${del.total})`)
  }
}
