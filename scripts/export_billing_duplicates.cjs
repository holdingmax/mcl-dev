const admin = require('firebase-admin')
const serviceAccount = require('C:\\Users\\dgarc\\Downloads\\wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'wms-mcl'
})
const db = admin.firestore()

async function main() {
  console.log('Fetching air_billing_charges...')
  const snap = await db.collection('air_billing_charges').get()
  console.log(`Total charges: ${snap.size}`)

  const charges = snap.docs.map(d => ({ id: d.id, ...d.data() }))

  // Group by billing_unit_id + charge_name to find duplicates
  const groups = {}
  for (const c of charges) {
    const key = `${c.billing_unit_id}||${c.charge_name}`
    if (!groups[key]) groups[key] = []
    groups[key].push(c)
  }

  // Find duplicates (count > 1)
  const duplicates = []
  let dupGroupCount = 0
  for (const [key, items] of Object.entries(groups)) {
    if (items.length > 1) {
      dupGroupCount++
      for (const c of items) {
        duplicates.push({
          dup_group: key,
          dup_count: items.length,
          charge_id: c.id,
          billing_unit_id: c.billing_unit_id || '',
          flight_id: c.flight_id || '',
          flight_number: c.flight_number || '',
          airline: c.airline || '',
          booking_id: c.booking_id || '',
          booking_type: c.booking_type || '',
          client_id: c.client_id || '',
          client_name: c.client_name || '',
          awb_1st_leg: c.awb_1st_leg || '',
          awb_2nd_leg: c.awb_2nd_leg || '',
          mawb_number: c.mawb_number || '',
          charge_name: c.charge_name || '',
          source: c.source || '',
          status: c.status || '',
          unit: c.unit || '',
          qty: c.qty || 0,
          rate: c.rate || 0,
          total: c.total || 0,
          chargeable_weight: c.chargeable_weight || 0,
          pieces: c.pieces || 0,
          invoice_id: c.invoice_id || '',
          created_at: c.created_at ? (c.created_at.toDate ? c.created_at.toDate().toISOString() : String(c.created_at)) : '',
          created_by: c.created_by || '',
          dispatched_at: c.dispatched_at ? (c.dispatched_at.toDate ? c.dispatched_at.toDate().toISOString() : String(c.dispatched_at)) : '',
        })
      }
    }
  }

  // Summary by flight
  const flightSummary = {}
  for (const d of duplicates) {
    const fk = d.flight_id
    if (!flightSummary[fk]) {
      flightSummary[fk] = {
        flight_id: fk,
        flight_number: d.flight_number,
        airline: d.airline,
        dup_charges: 0,
        dup_groups: new Set(),
        total_overcharge: 0,
        clients: new Set(),
        statuses: new Set(),
      }
    }
    flightSummary[fk].dup_charges++
    flightSummary[fk].dup_groups.add(`${d.billing_unit_id}||${d.charge_name}`)
    flightSummary[fk].clients.add(d.client_name)
    flightSummary[fk].statuses.add(d.status)
  }

  // Calculate overcharge per group (extra charges beyond the first)
  for (const [key, items] of Object.entries(groups)) {
    if (items.length > 1) {
      const extraCount = items.length - 1
      const totalPerItem = items[0].total || 0
      const fk = items[0].flight_id
      if (flightSummary[fk]) {
        flightSummary[fk].total_overcharge += totalPerItem * extraCount
      }
    }
  }

  // Also get ALL charges summary by status
  const statusCount = {}
  const statusTotal = {}
  for (const c of charges) {
    const s = c.status || 'unknown'
    statusCount[s] = (statusCount[s] || 0) + 1
    statusTotal[s] = (statusTotal[s] || 0) + (c.total || 0)
  }

  // Write JSON for Excel generation
  const output = {
    summary: {
      total_charges: charges.length,
      duplicate_groups: dupGroupCount,
      duplicate_records: duplicates.length,
      extra_records: duplicates.length - dupGroupCount, // records that should be deleted
      status_breakdown: Object.entries(statusCount).map(([s, c]) => ({
        status: s, count: c, total: statusTotal[s].toFixed(2)
      })),
    },
    flight_summary: Object.values(flightSummary).map(f => ({
      flight_id: f.flight_id,
      flight_number: f.flight_number,
      airline: f.airline,
      dup_charges: f.dup_charges,
      dup_groups: f.dup_groups.size,
      estimated_overcharge: f.total_overcharge.toFixed(2),
      clients: [...f.clients].join(', '),
      statuses: [...f.statuses].join(', '),
    })),
    duplicates: duplicates.sort((a, b) => {
      if (a.flight_id !== b.flight_id) return a.flight_id.localeCompare(b.flight_id)
      if (a.billing_unit_id !== b.billing_unit_id) return a.billing_unit_id.localeCompare(b.billing_unit_id)
      if (a.charge_name !== b.charge_name) return a.charge_name.localeCompare(b.charge_name)
      return (a.created_at || '').localeCompare(b.created_at || '')
    }),
  }

  const fs = require('fs')
  const outPath = 'C:\\Users\\dgarc\\Downloads\\billing_duplicates_raw.json'
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2))
  console.log(`\nSaved to: ${outPath}`)
  console.log(`\n=== SUMMARY ===`)
  console.log(`Total charges in collection: ${output.summary.total_charges}`)
  console.log(`Duplicate groups: ${output.summary.duplicate_groups}`)
  console.log(`Total duplicate records: ${output.summary.duplicate_records}`)
  console.log(`Extra records (to delete): ${output.summary.extra_records}`)
  console.log(`\nStatus breakdown:`)
  for (const s of output.summary.status_breakdown) {
    console.log(`  ${s.status}: ${s.count} charges, $${s.total}`)
  }
  console.log(`\nFlights with duplicates:`)
  for (const f of output.flight_summary) {
    console.log(`  ${f.airline} ${f.flight_number} (${f.flight_id}): ${f.dup_groups} groups, ${f.dup_charges} records, est. overcharge $${f.estimated_overcharge} [${f.statuses}]`)
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
