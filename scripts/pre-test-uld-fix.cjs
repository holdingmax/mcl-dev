const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  // ── 1. Flight status for both flights ──
  console.log('=== 1. FLIGHT STATUS ===')
  const flights = ['DhVLvCn7jLXVVKWOerVm', 'RKjqe6ru3Rbt3nv6XJgm']
  for (const fid of flights) {
    const f = await db.collection('airfreight_flights').doc(fid).get()
    if (f.exists) {
      const d = f.data()
      console.log('Flight:', fid.slice(0, 8), '|', d.flight_number, '|', (d.flight_datetime || '').slice(0, 10), '| status:', d.status, '| dispatched_at:', d.dispatched_at || 'none')
    }
  }

  // ── 2. The DO that references both ULDs ──
  console.log('\n=== 2. DO-0000189 DETAILS ===')
  const doSnap = await db.collection('delivery_orders').doc('brzdsGNkufrWa4vL4RaN').get()
  if (doSnap.exists) {
    const doData = doSnap.data()
    console.log('do_number:', doData.do_number, '| status:', doData.status, '| created_at:', doData.created_at)
    console.log('ulds_loaded:', JSON.stringify(doData.ulds_loaded))
    console.log('awb_entries:', (doData.awb_entries || []).length)
    for (const e of (doData.awb_entries || [])) {
      console.log('  AWB:', e.awb_number, '| flight:', e.flight_number, '| pcs:', e.pieces, '| C/P:', e.frozen_pc, '| booking:', (e.booking_id || '').slice(0, 8))
    }
    console.log('awb_keys:', JSON.stringify(doData.awb_keys))
  }

  // ── 3. All DOs that contain "PMC43256QT" ──
  console.log('\n=== 3. ALL DOs WITH PMC43256QT ===')
  const allDos = await db.collection('delivery_orders').where('ulds_loaded', 'array-contains', 'PMC43256QT').get()
  for (const d of allDos.docs) {
    const dd = d.data()
    console.log('DO:', d.id, '| do_number:', dd.do_number, '| status:', dd.status, '| ulds:', JSON.stringify(dd.ulds_loaded))
  }

  // ── 4. Billing charges linked to these DOs or AWBs ──
  console.log('\n=== 4. BILLING CHARGES ===')
  const awbsToCheck = ['729-93889784', '729-93889736', '729-93780632']
  for (const awb of awbsToCheck) {
    const charges = await db.collection('air_billing_charges').where('awb_number', '==', awb).get()
    if (charges.empty) {
      console.log('  ' + awb + ': no billing charges')
    } else {
      for (const c of charges.docs) {
        const cd = c.data()
        console.log('  ' + awb + ': charge', c.id.slice(0, 8), '| type:', cd.charge_type, '| amount:', cd.amount, '| invoice:', cd.invoice_id || 'none')
      }
    }
  }

  // ── 5. Bookings for both flights' AWBs ──
  console.log('\n=== 5. BOOKINGS FOR THESE AWBs ===')
  const bookings = await db.collection('airfreight_bookings').get()
  for (const awb of awbsToCheck) {
    for (const b of bookings.docs) {
      const bd = b.data()
      const lines = bd.awb_lines || []
      const match = lines.find(l => (l.awb_number || '') === awb || (l.awb_2nd_leg || '') === awb)
      if (match) {
        console.log('  ' + awb + ': booking', b.id.slice(0, 8), '| flight_id:', (bd.flight_id || '').slice(0, 8), '| flight_number:', bd.flight_number, '| type:', bd.booking_type, '| status:', bd.status)
      }
    }
  }

  // ── 6. Physical pieces for both ULDs ──
  console.log('\n=== 6. PHYSICAL PIECES STATUS ===')
  const uldIds = ['vfpA84plWrO0cc7EzNtS', 'xSl5n8yFp0ZsZ6OBXed9']
  for (const uid of uldIds) {
    const pcs = await db.collection('airfreight_physical_pieces').where('uld_id', '==', uid).get()
    const awbs = new Set()
    for (const p of pcs.docs) awbs.add(p.data().awb_number)
    console.log('  ULD', uid.slice(0, 8), ':', pcs.size, 'pieces | AWBs:', [...awbs].join(', '))
  }

  // ── 7. Doc receptions for these AWBs ──
  console.log('\n=== 7. DOC RECEPTIONS ===')
  for (const awb of awbsToCheck) {
    const drs = await db.collection('airfreight_doc_receptions').where('awb_number', '==', awb).get()
    if (drs.empty) {
      console.log('  ' + awb + ': no doc reception')
    } else {
      for (const d of drs.docs) {
        const dr = d.data()
        console.log('  ' + awb + ': DR', d.id.slice(0, 8), '| flight_id:', (dr.flight_id || '').slice(0, 8), '| booking_id:', (dr.booking_id || '').slice(0, 8), '| status:', dr.status)
      }
    }
  }

  // ── 8. Check how many ULDs have reuse across flights (scope check) ──
  console.log('\n=== 8. ULD REUSE ACROSS FLIGHTS (sample) ===')
  const allUlds = await db.collection('buildup_ulds').where('status', '==', 'closed').get()
  const uldCounts = new Map()
  for (const d of allUlds.docs) {
    const u = d.data()
    const key = (u.type || '') + (u.uld_number || '')
    uldCounts.set(key, (uldCounts.get(key) || 0) + 1)
  }
  const reused = [...uldCounts.entries()].filter(([, c]) => c > 1)
  console.log('Total closed ULDs:', allUlds.size, '| Unique numbers:', uldCounts.size, '| Reused numbers:', reused.length)
  for (const [name, count] of reused.slice(0, 10)) {
    console.log('  ' + name + ': ' + count + ' instances')
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
