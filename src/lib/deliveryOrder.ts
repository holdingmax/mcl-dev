import { doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs, runTransaction } from 'firebase/firestore'
import { ref, getBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from './firebase'
import { DeliveryOrder, AwbEntry } from '../types'
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from 'pdf-lib'

// ── DO# Sequence ────────────────────────────────────────────────────────────

export async function getNextDoNumber(): Promise<string> {
  const seqRef = doc(db, 'config', 'do_sequence')
  const next = await runTransaction(db, async (tx) => {
    const snap = await tx.get(seqRef)
    const last = snap.exists() ? (snap.data().last_num || 0) : 0
    const n = last + 1
    tx.set(seqRef, { last_num: n }, { merge: true })
    return n
  })
  return `DO-${String(next).padStart(7, '0')}`
}

// ── Firestore CRUD ──────────────────────────────────────────────────────────

/** Remove undefined values from an object (Firestore rejects them). */
function stripUndefined(obj: Record<string, any>): Record<string, any> {
  const clean: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) clean[k] = v
  }
  return clean
}

/** Convert a legacy single-AWB DO to multi-AWB format */
export function legacyToMulti(doData: DeliveryOrder): DeliveryOrder {
  if (doData.awb_entries && doData.awb_entries.length > 0) return doData
  // Legacy DO — convert
  const entry: AwbEntry = {
    booking_id: doData.booking_id || '',
    booking_type: 'ecommerce',
    awb_index: doData.awb_index ?? 0,
    awb_number: doData.awb_number || '',
    awb_1st_leg: doData.awb_1st_leg || '',
    client_name: doData.client_name || '',
    client_id: '',
    flight_number: doData.flight_number || '',
    flight_id: doData.flight_id || '',
    airline: doData.airline || '',
    destination: doData.destination || '',
    deliver_to: doData.deliver_to || '',
    pieces: doData.pieces || 0,
    weight: doData.weight || 0,
    has_battery: doData.has_battery || false,
  }
  return {
    ...doData,
    awb_entries: [entry],
    awb_keys: [`${entry.booking_id}::${entry.awb_index}`],
  }
}

export async function saveDeliveryOrder(doData: DeliveryOrder): Promise<string> {
  // Use pre-built awb_keys if provided, otherwise build from entries
  const awb_keys = (doData.awb_keys && doData.awb_keys.length > 0)
    ? doData.awb_keys
    : (doData.awb_entries || []).map(e => `${e.booking_id}::${e.awb_index}`)
  const toWrite = { ...doData, awb_keys }

  if (toWrite.id) {
    const ref = doc(db, 'delivery_orders', toWrite.id)
    const { id: _id, ...rest } = toWrite
    await updateDoc(ref, stripUndefined({ ...rest, updated_at: new Date().toISOString() }) as any)
    return toWrite.id
  }
  // New — assign DO#
  const doNumber = await getNextDoNumber()
  const ref = doc(collection(db, 'delivery_orders'))
  const now = new Date().toISOString()
  const { id: _id, ...rest } = toWrite
  const toSave = stripUndefined({
    ...rest,
    do_number: doNumber,
    created_at: now,
    status: 'draft',
  })
  await setDoc(ref, toSave)
  return ref.id
}

export async function loadDeliveryOrder(bookingId: string, awbIndex: number): Promise<(DeliveryOrder & { id: string }) | null> {
  const key = `${bookingId}::${awbIndex}`
  // Try new format first (array-contains on awb_keys)
  const q1 = query(
    collection(db, 'delivery_orders'),
    where('awb_keys', 'array-contains', key),
  )
  let snap = await getDocs(q1)
  if (snap.empty) {
    // Fallback: legacy format
    const q2 = query(
      collection(db, 'delivery_orders'),
      where('booking_id', '==', bookingId),
      where('awb_index', '==', awbIndex),
    )
    snap = await getDocs(q2)
  }
  if (snap.empty) return null
  const d = snap.docs[0]
  const raw = { ...d.data() as DeliveryOrder, id: d.id }
  return legacyToMulti(raw) as DeliveryOrder & { id: string }
}

/** Load a DO directly by its Firestore document ID */
export async function loadDeliveryOrderById(docId: string): Promise<(DeliveryOrder & { id: string }) | null> {
  const snap = await getDoc(doc(db, 'delivery_orders', docId))
  if (!snap.exists()) return null
  const raw = { ...snap.data() as DeliveryOrder, id: snap.id }
  return legacyToMulti(raw) as DeliveryOrder & { id: string }
}

/** Load ALL DOs for a given booking+awbIndex (including incremental keys like bookingId::awbIndex::1) */
export async function loadAllDOsForKey(bookingId: string, awbIndex: number): Promise<(DeliveryOrder & { id: string })[]> {
  const baseKey = `${bookingId}::${awbIndex}`
  // Query for the base key
  const q1 = query(collection(db, 'delivery_orders'), where('awb_keys', 'array-contains', baseKey))
  const snap1 = await getDocs(q1)
  const results = new Map<string, DeliveryOrder & { id: string }>()
  for (const d of snap1.docs) {
    const raw = { ...d.data() as DeliveryOrder, id: d.id }
    results.set(d.id, legacyToMulti(raw) as DeliveryOrder & { id: string })
  }
  // Also query incremental keys (::1, ::2, etc) — search by booking_id prefix
  // Since Firestore doesn't support startsWith on array fields, query all DOs for this booking_id
  const q2 = query(collection(db, 'delivery_orders'), where('awb_keys', 'array-contains', `${baseKey}::1`))
  const q3 = query(collection(db, 'delivery_orders'), where('awb_keys', 'array-contains', `${baseKey}::2`))
  const q4 = query(collection(db, 'delivery_orders'), where('awb_keys', 'array-contains', `${baseKey}::3`))
  const [snap2, snap3, snap4] = await Promise.all([getDocs(q2), getDocs(q3), getDocs(q4)])
  for (const s of [snap2, snap3, snap4]) {
    for (const d of s.docs) {
      if (!results.has(d.id)) {
        const raw = { ...d.data() as DeliveryOrder, id: d.id }
        results.set(d.id, legacyToMulti(raw) as DeliveryOrder & { id: string })
      }
    }
  }
  // Legacy fallback
  if (results.size === 0) {
    const qLeg = query(collection(db, 'delivery_orders'), where('booking_id', '==', bookingId), where('awb_index', '==', awbIndex))
    const snapLeg = await getDocs(qLeg)
    for (const d of snapLeg.docs) {
      const raw = { ...d.data() as DeliveryOrder, id: d.id }
      results.set(d.id, legacyToMulti(raw) as DeliveryOrder & { id: string })
    }
  }
  return [...results.values()].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
}

// ── HTML Templates ──────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${mm}/${dd}/${yyyy}`
}

export function buildDoHtml(doData: DeliveryOrder): string {
  const entries = doData.awb_entries || []
  const isSeal = doData.custody_method === 'seal'
  const isEscort = doData.custody_method === 'escort'
  const isLocked = doData.custody_method === 'locked_vehicle'
  const custodyLabel = isSeal ? `Tamper Evident Seal — #${doData.seal_number || ''}` :
    isEscort ? `Escort — ${doData.escort_name || ''}` : 'Locked Vehicle'

  const ulds = (doData.ulds_loaded || []).filter(u => u.trim())
  const uldsInline = ulds.map((u, i) => `<span style="font-family:monospace;font-weight:600;background:#f0f4f8;padding:1px 6px;border-radius:3px;border:1px solid #d0d5dd;">${u}</span>`).join(' ')

  const awbRowsHtml = entries.map(e =>
    `<tr>
      <td style="padding:3px 6px;border:1px solid #ccc;font-family:monospace;font-weight:700;font-size:8.5pt;letter-spacing:0.3px;">${e.awb_number || e.awb_1st_leg || ''}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;">${doData.do_number || 'PENDING'}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;">${fmtDate(doData.date)}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;">${e.deliver_to}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;">${e.destination}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;">${e.agent_name || e.client_name}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;">${e.flight_number}</td>
    </tr>`
  ).join('')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { margin: 0.4in 0.5in; size: letter; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .no-print { display: none !important; } }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 9pt; color: #1a1a1a; padding: 20px 30px; background: #fff; }
  .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #1a3a6b; padding-bottom: 8px; margin-bottom: 8px; }
  .company-sub { font-size: 7pt; color: #666; margin-top: 1px; }
  .do-badge { background: #1a3a6b; color: #fff; font-size: 11pt; font-weight: 800; padding: 5px 14px; border-radius: 5px; letter-spacing: 1px; }
  .title-bar { background: #f0f4f8; padding: 6px 10px; border-radius: 4px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
  .title-bar h2 { font-size: 10pt; font-weight: 700; color: #1a3a6b; }
  .title-bar .date { font-size: 9pt; color: #555; }
  .awb-table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  .awb-table th { background: #1a3a6b; color: #fff; padding: 3px 6px; font-size: 7pt; text-transform: uppercase; letter-spacing: 0.5px; text-align: left; }
  .awb-table td { border: 1px solid #ccc; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0; border: 1px solid #1a3a6b; border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
  .info-cell { padding: 5px 8px; border-right: 1px solid #e0e4e8; border-bottom: 1px solid #e0e4e8; }
  .info-cell:last-child { border-right: none; }
  .info-label { font-size: 6.5pt; text-transform: uppercase; letter-spacing: 0.6px; color: #888; font-weight: 600; }
  .info-value { font-size: 9pt; font-weight: 600; color: #1a1a1a; }
  .section-title { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.8px; color: #1a3a6b; font-weight: 700; margin: 8px 0 4px; padding-bottom: 2px; border-bottom: 1px solid #1a3a6b; }
  .sig-section { margin-top: 12px; }
  .sig-row { display: flex; gap: 24px; margin-bottom: 8px; }
  .sig-block { flex: 1; }
  .sig-line { border-top: 1px solid #333; margin-top: 22px; padding-top: 2px; font-size: 7pt; color: #666; text-transform: uppercase; letter-spacing: 0.4px; }
  .sig-name { font-size: 8pt; font-weight: 600; color: #333; }
  .footer { margin-top: 10px; border-top: 1.5px solid #1a3a6b; padding-top: 4px; display: flex; justify-content: space-between; font-size: 6.5pt; color: #999; }
  .print-btn { position: fixed; top: 10px; right: 10px; background: #1a3a6b; color: #fff; border: none; padding: 8px 18px; border-radius: 6px; font-size: 11pt; font-weight: 700; cursor: pointer; z-index: 100; }
  .print-btn:hover { background: #2a4a7b; }
</style>
</head><body>
  <button class="print-btn no-print" onclick="window.print()">Imprimir</button>
  <div class="header">
    <div>
      <img src="/logo.png" style="height:36px;" alt="MinCurl Logistics">
      <div class="company-sub">2323 NW 82ND AVE, Miami FL 33122</div>
    </div>
    <div class="do-badge">${doData.do_number || 'DO-PENDING'}</div>
  </div>

  <div class="title-bar">
    <h2>DELIVERY ORDER</h2>
    <div class="date">${fmtDate(doData.date)}</div>
  </div>

  <table class="awb-table">
    <thead><tr>
      <th>AWB</th><th>DO#</th><th>Fecha</th><th>Deliver To</th><th>Destino</th><th>Cliente</th><th>Vuelo</th>
    </tr></thead>
    <tbody>${awbRowsHtml}</tbody>
  </table>

  <div class="info-grid">
    <div class="info-cell">
      <div class="info-label">Trucking Company</div>
      <div class="info-value">${doData.trucking_company || '—'}</div>
    </div>
    <div class="info-cell">
      <div class="info-label">Driver Name</div>
      <div class="info-value">${doData.driver_name || '—'}</div>
    </div>
    <div class="info-cell">
      <div class="info-label">Chain of Custody</div>
      <div class="info-value">${custodyLabel}</div>
    </div>
  </div>

  ${ulds.length > 0 ? `
  <div class="section-title">ULDs Loaded</div>
  <div style="margin-bottom:8px;font-size:8.5pt;line-height:1.8;">${uldsInline}</div>
  ` : ''}

  <div class="section-title">MCL Agent</div>
  <div style="font-size:9pt;font-weight:600;margin-bottom:4px;">${doData.mcl_agent || '—'}</div>

  <div class="sig-section">
    <div class="sig-row">
      <div class="sig-block">
        <div class="sig-name">${doData.mcl_agent || ''}</div>
        <div class="sig-line">MCL Agent Signature</div>
      </div>
      <div class="sig-block">
        <div class="sig-name">${doData.driver_name || ''}</div>
        <div class="sig-line">Driver Signature</div>
      </div>
      <div class="sig-block">
        <div class="sig-line">Date / Time</div>
      </div>
    </div>
  </div>

  <div class="footer">
    <span>MinCurl Logistics LLC — CCSF# MIA.I.06.16.2025.588</span>
    <span>${doData.do_number || ''} — Generated ${new Date().toLocaleString('en-US')}</span>
  </div>
</body></html>`
}

/** Build per-AWB data for CCSF/LB by merging shared DO fields with a specific entry */
export function buildPerAwbDoData(doData: DeliveryOrder, entry: AwbEntry): DeliveryOrder & { awb_number: string; awb_1st_leg: string; pieces: number; weight: number; destination: string; has_battery: boolean; client_name: string } {
  return {
    ...doData,
    awb_number: entry.awb_number,
    awb_1st_leg: entry.awb_1st_leg,
    pieces: entry.pieces,
    weight: entry.weight,
    destination: entry.destination,
    has_battery: entry.has_battery,
    client_name: entry.client_name,
    airline: entry.airline,
    flight_number: entry.flight_number,
    deliver_to: entry.deliver_to,
  }
}

export function buildCcsfHtml(doData: DeliveryOrder): string {
  const isOriginated = doData.ccsf_screening_type === 'originated'
  const isSeal = doData.custody_method === 'seal'
  const isEscort = doData.custody_method === 'escort'
  const isLocked = doData.custody_method === 'locked_vehicle'
  const awb = doData.awb_number || doData.awb_1st_leg || ''

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { margin: 0.35in 0.6in; size: letter; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .no-print { display: none !important; } }
  body { font-family: 'Times New Roman', Times, serif; font-size: 10.5pt; color: #000; margin: 0; padding: 18px 40px; line-height: 1.4; }
  .logo { text-align: center; margin-bottom: 14px; }
  p { margin: 0 0 7px; text-align: justify; }
  .cb { display: inline-block; width: 12px; height: 12px; border: 1.5px solid #000; text-align: center; font-size: 9pt; line-height: 12px; vertical-align: middle; margin-right: 6px; }
  .cb.checked { position: relative; }
  .indent { margin-left: 36px; }
  .sig-underline { border-bottom: 1px solid #000; display: inline-block; min-width: 100%; margin-top: 2px; height: 16px; }
  .sig-label { font-size: 9pt; margin-top: 1px; margin-bottom: 6px; }
  .seal-line { border-bottom: 1px solid #000; display: inline-block; min-width: 250px; font-family: 'Segoe Script', 'Comic Sans MS', cursive; font-size: 11pt; padding: 0 4px; }
  .name-printed { font-size: 10.5pt; text-transform: uppercase; }
  .print-btn { position: fixed; top: 15px; right: 15px; background: #1a3a6b; color: #fff; border: none; padding: 10px 24px; border-radius: 8px; font-size: 12pt; font-weight: 700; cursor: pointer; z-index: 100; }
  .print-btn:hover { background: #2a4a7b; }
</style>
</head><body>
  <button class="print-btn no-print" onclick="window.print()">Imprimir</button>

  <div class="logo">
    <img src="/logo.png" style="height:80px;" alt="MinCurl Logistics">
  </div>

  <p>
    <b>Date:</b> ${fmtDate(doData.date)} Air waybill, bill of lading, company inventory, or other internal shipping document number: <b>${awb}</b>
  </p>

  <p>
    <b>MinCurl Logistics LLC</b> is a TSA-Certified Cargo Screening Facility (CCSF) and is in compliance with the TSA-approved certified cargo screening standard security program (CCSSSP). Our CCSF number assigned by TSA is CCSF # <b>MIA.I.06.16.2025.588</b>, which is applicable only to this facility, located at <b>2323 NW 82<sup>ND</sup> AVE Miami Fl 33122</b>. All cargo transferred or tendered in conjunction with this certificate was screened and transported in accordance with the CCSSSP requirements. A chain of custody method has been applied, and the cargo is being tendered with the chain of custody method intact. The individual whose name appears below certifies that he or she is an employee or authorized representative of <b>MinCurl Logistics LLC</b> and understands that any fraudulent or false statement made in connection with this certificate may subject <b>MinCurl Logistics LLC</b> and the individual to both (1) civil penalties under 49 CFR 1540.103(b) and (2) fines and/or imprisonment of not more than five years under 18 U.S.C. 1001."
  </p>

  <p>Check the applicable box below. The cargo associated with this Master Air Waybill was:</p>

  <p class="indent">
    <span class="cb ${isOriginated ? 'checked' : ''}">${isOriginated ? '&#10003;' : ''}</span>
    Originated by this CCSF and is screened at 100 percent.
  </p>
  <p class="indent">
    <span class="cb ${!isOriginated ? 'checked' : ''}">${!isOriginated ? '&#10003;' : ''}</span>
    Screened cargo at 100 percent on behalf of another regulated entity
  </p>

  <p style="margin-top:10px;">Check the applicable box below:</p>

  <p class="indent">
    <span class="cb ${isLocked ? 'checked' : ''}">${isLocked ? '&#10003;' : ''}</span>
    Locked vehicle
  </p>
  <p class="indent" style="margin-bottom:2px;">
    <span class="cb ${isSeal ? 'checked' : ''}">${isSeal ? '&#10003;' : ''}</span>
    Tamper evident numbered seal. If used, write the number of the seal associated with this cargo shipment below:
  </p>
  <p class="indent" style="margin-left:48px;">
    SEAL# <span class="seal-line">${isSeal ? (doData.seal_number || '') : ''}</span>
  </p>

  <p style="margin-top:10px;">If an escort is used, write the name of the escort associated with this cargo shipment below:</p>
  <p>
    <span style="border-bottom:1px solid #000;display:inline-block;min-width:100%;height:16px;">${isEscort ? (doData.escort_name || '') : ''}</span>
  </p>
  <p class="sig-label">(Print name of escort)</p>

  <p>Name and signature of employee or authorized representative attesting to the above certification:</p>

  <p class="name-printed">${doData.mcl_agent || ''}</p>
  <p>
    <span class="sig-underline"></span>
  </p>
  <p class="sig-label">(Sign and print name of employee or authorized representative)</p>

  <p>Name of company and name of driver delivering the cargo shipment:</p>

  <p>
    <span style="border-bottom:1px solid #000;display:inline-block;min-width:100%;padding-bottom:2px;">${doData.trucking_company || ''}${doData.trucking_company && doData.driver_name ? ' — ' : ''}${doData.driver_name || ''}</span>
  </p>
  <p class="sig-label">(Print name of company and driver) Print name of the accepting entity's employee or authorized representative who is verifying that the seal number written above matches the seal number on the conveyance OR is verifying the government issued identification of the escort and ensuring the name matches the name written above OR is verifying that the cargo arrived in a locked conveyance. Accepting Employee or Authorized Representative:</p>

  <p>
    <span style="border-bottom:1px solid #000;display:inline-block;min-width:100%;height:16px;"></span>
  </p>
  <p class="sig-label">(Signature and printed name of accepting entity's employee or authorized representative)</p>

</body></html>`
}

export function buildLbChecklistHtml(doData: DeliveryOrder): string {
  const awb = doData.awb_number || doData.awb_1st_leg || ''
  const isCao = doData.accepted_for === 'CAO'
  const isPax = doData.accepted_for === 'PAX'
  const chk = (v: boolean) => v ? 'X' : ''
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { margin: 0.4in 0.3in; size: letter; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .no-print { display: none !important; } }
  body { font-family: Arial, sans-serif; font-size: 9pt; color: #000; margin: 0; padding: 20px; }
  .cb { display: inline-block; width: 11px; height: 11px; border: 1.5px solid #000; text-align: center; font-size: 8pt; line-height: 11px; margin-right: 3px; vertical-align: middle; }
  .blank { border-bottom: 1px solid #000; display: inline-block; height: 14px; }
  .print-btn { position: fixed; top: 15px; right: 15px; background: #1a3a6b; color: #fff; border: none; padding: 10px 24px; border-radius: 8px; font-size: 12pt; font-weight: 700; cursor: pointer; z-index: 99; }
  .print-btn:hover { background: #2a4a7b; }
  .header-row { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1.5px solid #000; padding-bottom: 4px; margin-bottom: 6px; }
  .info-left { flex: 1; }
  .info-right { text-align: right; }
  .info-line { margin-bottom: 3px; font-size: 7pt; }
  .title-bar { font-weight: bold; font-size: 10pt; margin: 8px 0 4px; }
  .sub-note { font-size: 9pt; margin-bottom: 4px; }
  .checklist-section { font-weight: bold; font-size: 9pt; margin: 6px 0 2px; text-decoration: underline; }
  .item-row { margin: 2px 0; font-size: 9pt; padding-left: 4px; }
  .item-row .num { display: inline-block; width: 14px; }
  .pi-box { display: inline-block; border: 1px solid #000; padding: 1px 6px; margin: 0 2px; font-size: 8pt; text-align: center; line-height: 1.2; }
  .yes-no-row { display: flex; margin: 2px 0; }
  .yes-no-row .item-text { flex: 1; }
  .yes-no-row .cols { display: flex; width: 90px; }
  .yes-no-row .cols span { width: 30px; text-align: center; font-size: 8pt; }
  .bottom-fields { margin-top: 12px; }
  .bottom-fields .field-line { margin-bottom: 30px; }
  .sig-row { display: flex; margin-top: 10px; }
  .sig-row > div { flex: 1; }
  .footer-note { font-size: 7pt; margin-top: 20px; }
  .rev { font-size: 7pt; text-align: right; color: #555; }
</style>
</head><body>
  <button class="print-btn no-print" onclick="window.print()">Imprimir</button>

  <div class="header-row">
    <div class="info-left">
      <div style="font-size:9pt; font-weight:bold;">AWB Information</div>
    </div>
    <div class="info-right">
      <span class="cb">${chk(true)}</span> <b>Accepted</b><br>
      <span class="cb"></span> Rejected<br>
      <span class="cb"></span> Hold
    </div>
  </div>

  <div class="info-line"><b>Date (MM / DD / YYYY):</b> ${fmtDate(doData.date)}</div>
  <div class="info-line"><b>Master AWB #:</b> ${awb}</div>
  <div class="info-line"><b>Destination:</b> ${doData.destination || ''}</div>
  <div class="info-line"><b>Qty of Pieces:</b> (ELI) ${doData.pieces || '______'} &nbsp;&nbsp; (ELM) ______</div>
  <div class="info-line"><b>Total AWB Weight:</b> ${doData.weight || 0} kg</div>

  <div style="margin: 6px 0; text-align: right;">
    <b>Accepted for:</b>&nbsp;
    <span class="cb">${chk(isCao)}</span> CAO &nbsp;
    <span class="cb">${chk(isPax)}</span> PAX
  </div>

  <div class="title-bar">ACCEPTANCE CHECKLIST FOR LITHIUM ION / METAL BATTERIES - SECTION II</div>
  <div class="sub-note">Is the following information correct for each entry?</div>
  <div class="sub-note">Delete the non-applicable type unless both are carried.</div>

  <!-- Bordered checklist box -->
  <div style="border:1.5px solid #000; padding:6px 8px; margin-top:4px;">

  <!-- Air Waybill section -->
  <div style="display:flex; border-bottom:1px solid #000; padding-bottom:2px;">
    <div style="flex:1; font-weight:bold;">Air Waybill</div>
    <div style="width:90px; display:flex; font-weight:bold; font-size:8pt;">
      <span style="width:30px; text-align:center;">YES</span>
      <span style="width:30px; text-align:center;">NO*</span>
      <span style="width:30px; text-align:center;">N/A</span>
    </div>
  </div>

  <div class="yes-no-row">
    <div class="item-text">
      <span class="num">1.</span> The current text is included on the AWB, in the "Nature and Quantity of Goods" box [applicable PI, Section II].
      <div style="padding-left:18px; margin-top:2px;">- Batteries of ION / METAL lithium, according to section II of the Packing Instruction 966 / 967 / 969 / 970.</div>
    </div>
    <div class="cols"><span></span><span></span><span></span></div>
  </div>
  <div class="item-row" style="padding-left:18px;">- The packing instruction (circle the applicable one):</div>

  <div style="display:flex; margin:6px 0;">
    <div style="flex:1; text-align:center;">
      <span class="pi-box">"PI:<br>966"</span>
      <span class="pi-box">"PI:<br>967"</span>
      <span style="display:inline-block; width:30px;"></span>
      <span class="pi-box">"PI:<br>969"</span>
      <span class="pi-box">"PI:<br>970"</span>
    </div>
    <div class="cols" style="align-self:center;"><span></span><span></span><span></span></div>
  </div>
  <div style="display:flex;">
    <div style="flex:1; text-align:center; font-size:9pt; margin-bottom:6px;">
      <span style="display:inline-block; width:140px; text-align:center;">ION</span>
      <span style="display:inline-block; width:30px;"></span>
      <span style="display:inline-block; width:140px; text-align:center;">METAL</span>
    </div>
    <div style="width:90px;"></div>
  </div>

  <!-- Packages and Overpacks -->
  <div style="border-bottom:1px solid #000; margin-top:4px; padding-bottom:2px; font-weight:bold;">Packages and Overpacks</div>
  <div class="yes-no-row">
    <div class="item-text"><span class="num">2.</span> Packaging conforms with packing instructions and is free from damage, impacts or leakage [9.1.3.1.i].</div>
    <div class="cols"><span></span><span></span></div>
  </div>
  <div class="yes-no-row">
    <div class="item-text"><span class="num">3.</span> Each package must be marked with a lithium battery handling mark and duly completed with the corresponding data [Figure 7.1.c].</div>
    <div class="cols"><span></span><span></span></div>
  </div>
  <div class="yes-no-row">
    <div class="item-text"><span class="num">4.</span> The overpack must be marked with the word "Overpack" with a minimum height of 12 mm, and marked with the battery mark [Figure 7.1.c], unless the mark(s) on the package(s) inside the overpack are visible [7.1.7].</div>
    <div class="cols"><span></span><span></span><span></span></div>
  </div>

  <!-- General -->
  <div style="border-bottom:1px solid #000; margin-top:4px; padding-bottom:2px; font-weight:bold;">General</div>
  <div class="yes-no-row">
    <div class="item-text"><span class="num">5.</span> State and Operator variations complied with [2.8].</div>
    <div class="cols"><span></span><span></span><span></span></div>
  </div>
  <div class="yes-no-row">
    <div class="item-text"><span class="num">6.</span> The PI 969 - 970, will only be transported in CAO ("Cargo Only"), in PAX prohibited except for exceptions according to the current MOC 6.25.5.1.1 / Bol-CGO-LC 039. (Medical equipment for humanitarian purposes / Temperature control devices "data loggers")</div>
    <div class="cols"><span></span><span></span><span></span></div>
  </div>

  <!-- Bottom -->
  <div class="bottom-fields">
    <div style="margin-bottom:6px;"><b>Observations:</b></div>
    <div style="border-bottom:1px solid #000; height: 60px;"></div>
  </div>

  <div class="sig-row" style="margin-top:20px;">
    <div>
      <div><b>Checked by</b></div>
      <div style="border-bottom:1px solid #000; height:30px; width:90%;"></div>
      <div style="font-size:8pt;">Legible Name and Signature</div>
    </div>
    <div>
      <div><b>Place:</b></div>
      <div style="border-bottom:1px solid #000; height:30px; width:90%;"></div>
    </div>
    <div>
      <div><b>Date / Time</b></div>
      <div style="border-bottom:1px solid #000; height:30px; width:90%;"></div>
    </div>
  </div>

  </div><!-- end bordered checklist box -->

  <div class="footer-note">* IF ANY BOX IS CHECKED "NO", DO NOT ACCEPT THE SHIPMENT AND GIVE A DUPLICATE COPY OF THIS COMPLETED FORM TO THE SHIPPER.</div>
  <div class="rev">REV 00/2025</div>
</body></html>`
}

// ── Open HTML in new printable window ────────────────────────────────────────

export function openPrintableHtml(html: string, title: string): void {
  // Replace relative logo paths with absolute URL so the new window can load them
  const baseUrl = window.location.origin
  const resolved = html.replace(/src="\/logo\.png"/g, `src="${baseUrl}/logo.png"`)
  const win = window.open('', '_blank')
  if (!win) { alert('Popup bloqueado. Permite popups para este sitio.'); return }
  win.document.write(resolved)
  win.document.close()
  win.document.title = title
}

// ── HTML to PDF Blob (for sets — uses popup window for reliable rendering) ──

// ── PDF Utilities (pdf-lib) ─────────────────────────────────────────────────

/** Extract Firebase Storage path from a download URL */
function extractStoragePath(url: string): string | null {
  // URL format: https://firebasestorage.googleapis.com/v0/b/BUCKET/o/ENCODED_PATH?alt=media&token=...
  const match = url.match(/\/o\/([^?]+)/)
  if (match) return decodeURIComponent(match[1])
  return null
}

export async function fetchPdfAsArrayBuffer(url: string): Promise<ArrayBuffer> {
  // Firebase Storage URLs — extract path and use SDK (handles auth, bypasses CORS)
  const storagePath = extractStoragePath(url)
  if (storagePath) {
    const storageRef = ref(storage, storagePath)
    const bytes = await getBytes(storageRef)
    return bytes
  }
  // Fallback for non-Firebase URLs
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Failed to fetch PDF: ${resp.status}`)
  return resp.arrayBuffer()
}

/** Extract the penultimate page (N-1) from a PDF. Returns a single-page PDF ArrayBuffer. */
export async function extractPenultimatePage(pdfBytes: ArrayBuffer): Promise<ArrayBuffer> {
  const src = await PDFDocument.load(pdfBytes)
  const count = src.getPageCount()
  if (count < 2) return pdfBytes
  const dest = await PDFDocument.create()
  const [page] = await dest.copyPages(src, [count - 2])
  dest.addPage(page)
  const bytes = await dest.save()
  return bytes.buffer as ArrayBuffer
}

/** Check if an ArrayBuffer starts with the PDF header (%PDF-) */
function isPdfBuffer(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 5) return false
  const header = new Uint8Array(buf, 0, 5)
  return header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46 && header[4] === 0x2D // %PDF-
}

/** Merge multiple PDF ArrayBuffers into one. Skips non-PDF buffers gracefully. */
export async function mergePdfBuffers(
  items: { buffer: ArrayBuffer; copies?: number; pageIndices?: number[] }[],
): Promise<ArrayBuffer> {
  const merged = await PDFDocument.create()
  for (const item of items) {
    if (!isPdfBuffer(item.buffer)) {
      console.warn('mergePdfBuffers: skipping non-PDF buffer (no %PDF- header)')
      continue
    }
    try {
      const copies = item.copies || 1
      const src = await PDFDocument.load(item.buffer)
      const totalPages = src.getPageCount()
      const indices = item.pageIndices || Array.from({ length: totalPages }, (_, i) => i)
      for (let c = 0; c < copies; c++) {
        const pages = await merged.copyPages(src, indices)
        for (const p of pages) merged.addPage(p)
      }
    } catch (err) {
      console.warn('mergePdfBuffers: skipping corrupt PDF buffer', err)
    }
  }
  const bytes = await merged.save()
  return bytes.buffer as ArrayBuffer
}

// ── pdf-lib helpers ─────────────────────────────────────────────────────────

function wrapText(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w
    if (font.widthOfTextAtSize(test, fontSize) > maxWidth) {
      if (cur) lines.push(cur)
      cur = w
    } else cur = test
  }
  if (cur) lines.push(cur)
  return lines
}

function drawCheckbox(page: PDFPage, x: number, y: number, checked: boolean) {
  page.drawRectangle({ x, y: y - 1, width: 10, height: 10, borderWidth: 1, borderColor: rgb(0, 0, 0), color: rgb(1, 1, 1) })
  if (checked) {
    // Draw checkmark (V shape)
    page.drawLine({ start: { x: x + 2, y: y + 5 }, end: { x: x + 4, y: y + 1 }, thickness: 1.3, color: rgb(0, 0, 0) })
    page.drawLine({ start: { x: x + 4, y: y + 1 }, end: { x: x + 8, y: y + 7 }, thickness: 1.3, color: rgb(0, 0, 0) })
  }
}

async function embedLogo(pdfDoc: PDFDocument): Promise<{ img: Awaited<ReturnType<PDFDocument['embedPng']>>; w: number; h: number } | null> {
  try {
    const resp = await fetch(`${window.location.origin}/logo.png`)
    const bytes = new Uint8Array(await resp.arrayBuffer())
    const img = await pdfDoc.embedPng(bytes)
    const h = 55
    const w = (img.width / img.height) * h
    return { img, w, h }
  } catch { return null }
}

// ── CCSF PDF (pure pdf-lib, no HTML) ────────────────────────────────────────

export async function buildCcsfPdfBuffer(doData: DeliveryOrder): Promise<ArrayBuffer> {
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([612, 792]) // Letter
  const regular = await pdfDoc.embedFont(StandardFonts.TimesRoman)
  const bold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold)

  const LM = 45, CW = 612 - LM * 2
  const FS = 10, LH = 13
  let y = 758

  // Logo
  const logo = await embedLogo(pdfDoc)
  if (logo) {
    page.drawImage(logo.img, { x: (612 - logo.w) / 2, y: y - logo.h, width: logo.w, height: logo.h })
    y -= logo.h + 14
  } else { y -= 20 }

  // Helper: draw paragraph, returns new y
  const para = (text: string, font: PDFFont, size: number, indent = 0) => {
    const lines = wrapText(text, font, size, CW - indent)
    for (const line of lines) {
      page.drawText(line, { x: LM + indent, y, size, font, color: rgb(0, 0, 0) })
      y -= LH
    }
  }
  const hline = (x1: number, x2: number) => {
    page.drawLine({ start: { x: x1, y: y }, end: { x: x2, y }, thickness: 0.7, color: rgb(0, 0, 0) })
  }

  const awb = doData.awb_number || doData.awb_1st_leg || ''
  const dateStr = fmtDate(doData.date)

  // Date + AWB line
  para(`Date: ${dateStr}  Air waybill, bill of lading, company inventory, or other internal shipping document number: ${awb}`, regular, FS)
  y -= 4

  // Main legal paragraph
  para(
    'MinCurl Logistics LLC is a TSA-Certified Cargo Screening Facility (CCSF) and is in compliance with the TSA-approved certified cargo screening standard security program (CCSSSP). Our CCSF number assigned by TSA is CCSF # MIA.I.06.16.2025.588, which is applicable only to this facility, located at 2323 NW 82ND AVE Miami Fl 33122. All cargo transferred or tendered in conjunction with this certificate was screened and transported in accordance with the CCSSSP requirements. A chain of custody method has been applied, and the cargo is being tendered with the chain of custody method intact. The individual whose name appears below certifies that he or she is an employee or authorized representative of MinCurl Logistics LLC and understands that any fraudulent or false statement made in connection with this certificate may subject MinCurl Logistics LLC and the individual to both (1) civil penalties under 49 CFR 1540.103(b) and (2) fines and/or imprisonment of not more than five years under 18 U.S.C. 1001.',
    regular, FS,
  )
  y -= 6

  // Screening type checkboxes
  const isOriginated = doData.ccsf_screening_type === 'originated'
  para('Check the applicable box below. The cargo associated with this Master Air Waybill was:', regular, FS)
  y -= 2
  drawCheckbox(page, LM + 18, y, isOriginated)
  page.drawText('Originated by this CCSF and is screened at 100 percent.', { x: LM + 33, y, size: FS, font: regular })
  y -= LH + 2
  drawCheckbox(page, LM + 18, y, !isOriginated)
  page.drawText('Screened cargo at 100 percent on behalf of another regulated entity', { x: LM + 33, y, size: FS, font: regular })
  y -= LH + 6

  // Custody method checkboxes
  const isSeal = doData.custody_method === 'seal'
  const isEscort = doData.custody_method === 'escort'
  const isLocked = doData.custody_method === 'locked_vehicle'

  para('Check the applicable box below:', regular, FS)
  y -= 2
  drawCheckbox(page, LM + 18, y, isLocked)
  page.drawText('Locked vehicle', { x: LM + 33, y, size: FS, font: regular })
  y -= LH + 2
  drawCheckbox(page, LM + 18, y, isSeal)
  page.drawText('Tamper evident numbered seal. If used, write the number of the seal', { x: LM + 33, y, size: FS, font: regular })
  y -= LH
  page.drawText('associated with this cargo shipment below:', { x: LM + 33, y, size: FS, font: regular })
  y -= LH + 3

  // SEAL# line
  page.drawText('SEAL#', { x: LM + 33, y, size: FS, font: bold })
  const sealX = LM + 33 + bold.widthOfTextAtSize('SEAL# ', FS)
  if (isSeal && doData.seal_number) {
    page.drawText(doData.seal_number, { x: sealX, y, size: FS, font: regular })
  }
  y -= 3
  hline(sealX, LM + CW - 40)
  y -= LH + 4

  // Escort
  para('If an escort is used, write the name of the escort associated with this cargo shipment below:', regular, FS)
  y -= 2
  if (isEscort && doData.escort_name) {
    page.drawText(doData.escort_name, { x: LM, y, size: FS, font: regular })
  }
  y -= 3; hline(LM, LM + CW); y -= LH
  page.drawText('(Print name of escort)', { x: LM, y, size: 8, font: regular })
  y -= LH + 4

  // Certification signature
  para('Name and signature of employee or authorized representative attesting to the above certification:', regular, FS)
  y -= 3
  if (doData.mcl_agent) {
    page.drawText(doData.mcl_agent.toUpperCase(), { x: LM, y, size: FS, font: regular })
  }
  y -= 5; hline(LM, LM + CW); y -= LH
  page.drawText('(Sign and print name of employee or authorized representative)', { x: LM, y, size: 8, font: regular })
  y -= LH + 4

  // Company and driver
  para('Name of company and name of driver delivering the cargo shipment:', regular, FS)
  const companyDriver = [doData.trucking_company, doData.driver_name].filter(Boolean).join(' — ')
  if (companyDriver) { page.drawText(companyDriver, { x: LM, y: y - 2, size: FS, font: bold }); }
  y -= 5; hline(LM, LM + CW); y -= LH

  // Accepting entity paragraph (smaller font)
  const acceptLines = wrapText(
    "(Print name of company and driver) Print name of the accepting entity's employee or authorized representative who is verifying that the seal number written above matches the seal number on the conveyance OR is verifying the government issued identification of the escort and ensuring the name matches the name written above OR is verifying that the cargo arrived in a locked conveyance. Accepting Employee or Authorized Representative:",
    regular, 8, CW,
  )
  for (const line of acceptLines) {
    page.drawText(line, { x: LM, y, size: 8, font: regular, color: rgb(0, 0, 0) })
    y -= 11
  }
  y -= 5; hline(LM, LM + CW); y -= LH
  page.drawText("(Signature and printed name of accepting entity's employee or authorized representative)", { x: LM, y, size: 8, font: regular })

  const bytes = await pdfDoc.save()
  return bytes.buffer as ArrayBuffer
}

// ── CCSSSP PDF (client's own security program) ──────────────────────────────

export interface CcssspClientInfo {
  company_name: string       // header name e.g. "EXPRESS LINE CORPORATION"
  short_name?: string        // in-text reference e.g. "EXPRESS LINE CORP." (defaults to company_name)
  tsa_number: string         // e.g. "WP9403041"
  address?: string           // e.g. "901 W. Arbor Vitae St. Inglewood, CA 90301"
  phone?: string
  email?: string
  logo_url?: string          // Firebase Storage URL for left logo
  logo_right_url?: string    // Firebase Storage URL for right logo (e.g. C-TPAT)
  format?: string            // 'express_line' | 'merflex' — per-client template
  rep_name?: string          // Fixed representative name (e.g. "Carlos Villegas" for Merflex)
  signature_url?: string     // Firebase Storage URL for signature image
}

async function embedClientLogo(
  pdfDoc: PDFDocument,
  logoUrl: string | undefined,
): Promise<{ img: Awaited<ReturnType<PDFDocument['embedPng']>>; w: number; h: number } | null> {
  if (!logoUrl) return null
  try {
    let bytes: Uint8Array
    if (logoUrl.startsWith('gs://')) {
      // Firebase Storage path — extract the file path after the bucket
      const path = logoUrl.replace(/^gs:\/\/[^/]+\//, '')
      bytes = new Uint8Array(await getBytes(ref(storage, path)))
    } else {
      const resp = await fetch(logoUrl)
      bytes = new Uint8Array(await resp.arrayBuffer())
    }
    const isPng = logoUrl.toLowerCase().includes('.png') || bytes[0] === 0x89
    const img = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes)
    const h = 50
    const w = (img.width / img.height) * h
    return { img, w, h }
  } catch (err) {
    console.error('Error loading client logo:', err)
    return null
  }
}

export async function buildCcssspPdfBuffer(
  doData: DeliveryOrder,
  clientInfo: CcssspClientInfo,
): Promise<ArrayBuffer> {
  if (clientInfo.format === 'merflex') return buildCcssspMerflex(doData, clientInfo)
  return buildCcssspExpressLine(doData, clientInfo)
}

// ── CCSSSP: Express Line format ──
async function buildCcssspExpressLine(
  doData: DeliveryOrder,
  clientInfo: CcssspClientInfo,
): Promise<ArrayBuffer> {
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([612, 792]) // Letter
  const regular = await pdfDoc.embedFont(StandardFonts.TimesRoman)
  const bold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold)
  const boldItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanBoldItalic)

  const LM = 45, RM = 612 - 45, CW = RM - LM
  const FS = 10, LH = 13
  let y = 758

  // Helper: draw wrapped paragraph
  const para = (text: string, font: PDFFont, size: number, indent = 0) => {
    const lines = wrapText(text, font, size, CW - indent)
    for (const line of lines) {
      page.drawText(line, { x: LM + indent, y, size, font, color: rgb(0, 0, 0) })
      y -= LH
    }
  }
  // Helper: draw horizontal underline at current y
  const hline = (x1: number, x2: number) => {
    page.drawLine({ start: { x: x1, y: y }, end: { x: x2, y }, thickness: 0.7, color: rgb(0, 0, 0) })
  }
  // Helper: draw text with underline
  const drawUnderlined = (text: string, x: number, yPos: number, font: PDFFont, size: number) => {
    page.drawText(text, { x, y: yPos, size, font, color: rgb(0, 0, 0) })
    const w = font.widthOfTextAtSize(text, size)
    page.drawLine({ start: { x, y: yPos - 1.5 }, end: { x: x + w, y: yPos - 1.5 }, thickness: 0.7, color: rgb(0, 0, 0) })
  }

  // ── Header with optional logos (left + right) ──
  const logoLeft = await embedClientLogo(pdfDoc, clientInfo.logo_url)
  const logoRight = await embedClientLogo(pdfDoc, clientInfo.logo_right_url)

  if (logoLeft || logoRight) {
    const headerH = Math.max(logoLeft?.h || 0, logoRight?.h || 0, 50)

    if (logoLeft) {
      page.drawImage(logoLeft.img, { x: LM, y: y - logoLeft.h, width: logoLeft.w, height: logoLeft.h })
    }
    if (logoRight) {
      page.drawImage(logoRight.img, { x: RM - logoRight.w, y: y - logoRight.h, width: logoRight.w, height: logoRight.h })
    }

    // Center: company name + address + contact between logos
    const leftEdge = logoLeft ? LM + logoLeft.w + 10 : LM
    const rightEdge = logoRight ? RM - logoRight.w - 10 : RM
    const centerX = (leftEdge + rightEdge) / 2
    const nameWidth = bold.widthOfTextAtSize(clientInfo.company_name, 16)
    page.drawText(clientInfo.company_name, { x: centerX - nameWidth / 2, y: y - 20, size: 16, font: bold })

    if (clientInfo.address) {
      const addrW = bold.widthOfTextAtSize(clientInfo.address, 9)
      page.drawText(clientInfo.address, { x: centerX - addrW / 2, y: y - 34, size: 9, font: bold })
    }
    const contactLine = [clientInfo.phone ? `Tel: ${clientInfo.phone}` : '', clientInfo.email ? `Email: ${clientInfo.email}` : ''].filter(Boolean).join('       ')
    if (contactLine) {
      const cW = bold.widthOfTextAtSize(contactLine, 9)
      page.drawText(contactLine, { x: centerX - cW / 2, y: y - 47, size: 9, font: bold })
    }
    y -= headerH + 25
  } else {
    // No logos — text-only header
    page.drawText(clientInfo.company_name, { x: LM, y, size: 16, font: bold })
    y -= 20
    if (clientInfo.address) {
      page.drawText(clientInfo.address, { x: LM, y, size: 9, font: bold })
      y -= 14
    }
    const contactLine = [clientInfo.phone ? `Tel: ${clientInfo.phone}` : '', clientInfo.email ? `Email: ${clientInfo.email}` : ''].filter(Boolean).join('       ')
    if (contactLine) {
      page.drawText(contactLine, { x: LM, y, size: 9, font: bold })
      y -= 14
    }
    y -= 10
  }

  // ── Date + AWB ──
  const awb = doData.awb_number || doData.awb_1st_leg || ''
  const dateStr = fmtDate(doData.date)

  page.drawText('Date: ', { x: LM, y, size: FS, font: regular })
  const dateValX = LM + regular.widthOfTextAtSize('Date: ', FS)
  page.drawText(dateStr, { x: dateValX, y, size: FS, font: regular })
  y -= LH + 4

  page.drawText('Air waybill or other shipping document number: ', { x: LM, y, size: FS, font: regular })
  const awbValX = LM + regular.widthOfTextAtSize('Air waybill or other shipping document number: ', FS)
  page.drawText(awb, { x: awbValX, y, size: FS, font: regular })
  y -= LH + 8

  // ── Main legal paragraph with underlined company name and TSA# ──
  // We use a "rich text" approach: render word-by-word, underlining the company name and TSA number
  const companyName = clientInfo.company_name
  const shortName = clientInfo.short_name || companyName  // short form for in-text references (e.g. "EXPRESS LINE CORP.")
  const tsaNum = clientInfo.tsa_number

  const legalText =
    `${shortName} is in compliance with the TSA-approved security program and all appropriate security directive(s).  Our ` +
    `number assigned by TSA is ${tsaNum}. All cargo tendered in conjunction with this certificate was either: 1) accepted from a Known ` +
    `Shipper or an Unknown Shipper in accordance with TSA requirements specified in the Indirect Air Carrier Standard Security Program, ` +
    `or 2) accepted under transfer from another direct or indirect air carrier operating under a TSA-approved or accepted security program. ` +
    `All cargo has been screened and transported in accordance with the CCSSSP requirements.  A chain of custody method has been ` +
    `applied, and the cargo is being tendered with the chain of custody method intact. The individual whose name appears below certifies ` +
    `that he or she is an employee or authorized representative of ${shortName} and understands that any fraudulent or false ` +
    `statement made in connection with this certification may subject ${shortName} and the individual to both (1) civil penalties ` +
    `under 49 CFR 1540.103(b) and (2) fines and/or imprisonment of not more than five years under 18 U.S.C. 1001.`

  // Render the legal paragraph with underlined segments for company name and TSA#
  const underlinedSegments = [shortName, tsaNum]
  const words = legalText.split(' ')
  let lineX = LM
  const maxX = LM + CW
  // We need to track multi-word underlined segments
  let pendingUnderline = ''
  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi]
    const testW = regular.widthOfTextAtSize(word + ' ', FS)
    if (lineX + testW > maxX && lineX > LM) {
      // New line
      y -= LH
      lineX = LM
    }
    // Check if this word starts an underlined segment
    let isUnderlined = false
    for (const seg of underlinedSegments) {
      // Check if this word (or sequence of words) matches the segment
      const segWords = seg.split(' ')
      if (wi + segWords.length <= words.length) {
        const candidate = words.slice(wi, wi + segWords.length).join(' ')
        // Strip trailing punctuation for comparison
        const cleanCandidate = candidate.replace(/[.,;:]+$/, '')
        const cleanSeg = seg.replace(/[.,;:]+$/, '')
        if (cleanCandidate === cleanSeg || candidate === seg) {
          // Draw entire segment underlined with bold
          const fullSeg = candidate
          const segW = bold.widthOfTextAtSize(fullSeg, FS)
          if (lineX + segW > maxX && lineX > LM) {
            y -= LH
            lineX = LM
          }
          drawUnderlined(fullSeg, lineX, y, bold, FS)
          lineX += segW + regular.widthOfTextAtSize(' ', FS)
          wi += segWords.length - 1 // skip consumed words
          isUnderlined = true
          break
        }
      }
    }
    if (!isUnderlined) {
      const wW = regular.widthOfTextAtSize(word, FS)
      page.drawText(word, { x: lineX, y, size: FS, font: regular })
      lineX += wW + regular.widthOfTextAtSize(' ', FS)
    }
  }
  y -= LH + 8

  // ── Screening type checkboxes (PAX = Known Shipper, CAO = Unknown Shipper) ──
  const isPax = doData.accepted_for === 'PAX'

  page.drawText('Check the applicable box below: The cargo associated with this Master Air Waybill :', { x: LM, y, size: FS, font: regular })
  y -= LH + 6

  drawCheckbox(page, LM + 18, y, isPax)
  const opt1Lines = wrapText('Can be transported on Passenger Aircraft or All-Cargo Aircraft because it originated from a Known Shipper and is screened at 100 percent.', bold, FS, CW - 38)
  for (const line of opt1Lines) {
    page.drawText(line, { x: LM + 38, y, size: FS, font: bold })
    y -= LH
  }
  y -= 6
  drawCheckbox(page, LM + 18, y, !isPax)
  const opt2Lines = wrapText('Can only be transported on All-Cargo Aircraft because it originated from an Unknown Shipper and is screened at 100 percent.', bold, FS, CW - 38)
  for (const line of opt2Lines) {
    page.drawText(line, { x: LM + 38, y, size: FS, font: bold })
    y -= LH
  }
  y -= 8

  // ── Custody method checkboxes ──
  const isSeal = doData.custody_method === 'seal'
  const isEscort = doData.custody_method === 'escort'
  const isLocked = doData.custody_method === 'locked_vehicle'

  page.drawText('Check the applicable box below :', { x: LM, y, size: FS, font: regular })
  y -= LH + 4
  drawCheckbox(page, LM + 18, y, isLocked)
  page.drawText('Locked vehicle', { x: LM + 33, y, size: FS, font: regular })
  y -= LH + 2
  drawCheckbox(page, LM + 18, y, isSeal)
  page.drawText('Tamper evident numbered seal. If used, write the number of the seal associated with this cargo shipment below:', { x: LM + 33, y, size: FS, font: regular })
  y -= LH + 4
  // Seal number line
  if (isSeal && doData.seal_number) {
    page.drawText(doData.seal_number, { x: LM + 33, y, size: FS, font: regular })
  }
  y -= 3; hline(LM + 33, RM - 20); y -= LH + 6

  // ── Escort ──
  drawCheckbox(page, LM + 18, y, isEscort)
  const escortText = wrapText('If an escort is used, write the name of the escort associated with this cargo shipment below:', bold, FS, CW - 38)
  for (const line of escortText) {
    page.drawText(line, { x: LM + 38, y, size: FS, font: bold })
    y -= LH
  }
  y -= 4
  if (isEscort && doData.escort_name) {
    page.drawText(doData.escort_name, { x: LM, y, size: FS, font: regular })
  }
  y -= 3; hline(LM, RM); y -= LH
  page.drawText('(Print name of escort)', { x: LM, y, size: 8, font: regular })
  y -= LH + 6

  // ── Certification signature ──
  page.drawText('Name and signature of employee or authorized representative attesting to the above certification:', { x: LM, y, size: FS, font: boldItalic })
  y -= LH + 4
  if (doData.mcl_agent) {
    page.drawText(doData.mcl_agent.toUpperCase(), { x: LM, y, size: FS, font: regular })
  }
  y -= 5; hline(LM, RM); y -= LH
  page.drawText('(Sign and print name of employee or authorized representative)', { x: LM, y, size: 8, font: regular })
  y -= LH + 6

  // ── Company and driver ──
  page.drawText('Name of company and name of driver delivering the cargo shipment:', { x: LM, y, size: FS, font: boldItalic })
  y -= LH + 4
  const companyDriver = [doData.trucking_company, doData.driver_name].filter(Boolean).join(' \u2014 ')
  if (companyDriver) { page.drawText(companyDriver, { x: LM, y, size: FS, font: regular }) }
  y -= 5; hline(LM, RM); y -= LH
  page.drawText('(Print name of company and driver)', { x: LM, y, size: 8, font: regular })
  y -= LH + 6

  // ── Accepting entity — 3 separate paragraphs like the template ──
  const accept1 = wrapText(
    "Print name of the accepting entity's employee or authorized representative who is verifying that the seal number written above matches the seal number on the conveyance",
    regular, 8, CW,
  )
  for (const line of accept1) {
    page.drawText(line, { x: LM, y, size: 8, font: regular })
    y -= 11
  }
  y -= 2
  const accept2 = wrapText(
    'OR is verifying the government-issued identification of the escort and ensuring the name matches the name written above OR is verifying that the cargo arrived in a locked conveyance.',
    regular, 8, CW,
  )
  for (const line of accept2) {
    page.drawText(line, { x: LM, y, size: 8, font: regular })
    y -= 11
  }
  y -= 8

  page.drawText('Accepting Employee or Authorized Representative:', { x: LM, y, size: FS, font: boldItalic })
  y -= LH + 10; hline(LM, RM); y -= LH
  page.drawText('(Print name of accepting employee or authorized representative)', { x: LM, y, size: 8, font: regular })

  const bytes = await pdfDoc.save()
  return bytes.buffer as ArrayBuffer
}

// ── CCSSSP: Merflex format ──
async function buildCcssspMerflex(
  doData: DeliveryOrder,
  clientInfo: CcssspClientInfo,
): Promise<ArrayBuffer> {
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([612, 792])
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const LM = 50, RM = 612 - 50, CW = RM - LM
  const FS = 10, LH = 14
  let y = 745

  const para = (text: string, font: PDFFont, size: number, indent = 0) => {
    const lines = wrapText(text, font, size, CW - indent)
    for (const line of lines) {
      page.drawText(line, { x: LM + indent, y, size, font, color: rgb(0, 0, 0) })
      y -= LH
    }
  }
  const hline = (x1: number, x2: number) => {
    page.drawLine({ start: { x: x1, y: y }, end: { x: x2, y }, thickness: 0.7, color: rgb(0, 0, 0) })
  }

  // ── Header: just company name ──
  const companyName = clientInfo.company_name
  page.drawText('MERFLEX', { x: LM, y, size: 18, font: bold })
  y -= 30

  // ── Date + AWB ──
  const awb = doData.awb_number || doData.awb_1st_leg || ''
  const dateStr = fmtDate(doData.date)

  page.drawText('Date: ' + dateStr, { x: LM, y, size: FS, font: regular })
  y -= LH + 4
  page.drawText('Air waybill, bill of lading, company inventory, or other internal shipping document number: ' + awb, { x: LM, y, size: FS, font: regular })
  y -= LH + 12

  // ── Main legal paragraph — Merflex uses bold for company name inline ──
  const shortName = clientInfo.short_name || companyName
  const tsaNum = clientInfo.tsa_number

  // Render paragraph word by word, bolding the company name occurrences
  const legalText =
    `${shortName} is in compliance with the TSA-approved certified cargo screening ` +
    `standard security program (CCSSSP) and all appropriate security directive(s). Our number assigned by ` +
    `TSA is ${tsaNum}. All cargo tendered in conjunction with this certificate was either: 1) accepted from a ` +
    `Known Shipper or an Unknown Shipper in accordance with TSA requirements specified in the Indirect Air ` +
    `Carrier Standard Security Program, or 2) accepted under transfer from another direct or indirect air ` +
    `carrier operating under a TSA approved or accepted security program. All cargo has been screened and ` +
    `transported in accordance with the CCSSSP requirements. A chain of custody method has been applied, ` +
    `and the cargo is being tendered with the chain of custody method intact. The individual whose name ` +
    `appears below certifies that he or she is an employee or authorized representative of ${shortName} ` +
    `and understands that any fraudulent or false statement made in connection with ` +
    `this certification may ${shortName} and the individual to both (1) civil penalties under ` +
    `49 CFR 1540.103(b) and (2) fines and/or imprisonment of not more than five years under 18 U.S.C. 1001.`

  // Render with bold segments for company name
  const boldSegments = [shortName, tsaNum]
  const words = legalText.split(' ')
  let lineX = LM
  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi]
    const testW = regular.widthOfTextAtSize(word + ' ', FS)
    if (lineX + testW > RM && lineX > LM) {
      y -= LH
      lineX = LM
    }
    let isBold = false
    for (const seg of boldSegments) {
      const segWords = seg.split(' ')
      if (wi + segWords.length <= words.length) {
        const candidate = words.slice(wi, wi + segWords.length).join(' ')
        const cleanCandidate = candidate.replace(/[.,;:)]+$/, '')
        const cleanSeg = seg.replace(/[.,;:)]+$/, '')
        if (cleanCandidate === cleanSeg || candidate === seg) {
          const fullSeg = candidate
          const segW = bold.widthOfTextAtSize(fullSeg, FS)
          if (lineX + segW > RM && lineX > LM) { y -= LH; lineX = LM }
          page.drawText(fullSeg, { x: lineX, y, size: FS, font: bold })
          lineX += segW + regular.widthOfTextAtSize(' ', FS)
          wi += segWords.length - 1
          isBold = true
          break
        }
      }
    }
    if (!isBold) {
      const wW = regular.widthOfTextAtSize(word, FS)
      page.drawText(word, { x: lineX, y, size: FS, font: regular })
      lineX += wW + regular.widthOfTextAtSize(' ', FS)
    }
  }
  y -= LH + 10

  // ── Screening type checkboxes ──
  const isPax = doData.accepted_for === 'PAX'

  page.drawText('The cargo associated with this Master Air Waybill:', { x: LM + 10, y, size: FS, font: regular })
  y -= LH + 4

  drawCheckbox(page, LM + 18, y, isPax)
  const opt1Lines = wrapText('can be transported on passenger aircraft or all-cargo aircraft because it originated from a known shipper and is screened at 100 percent', regular, FS, CW - 38)
  for (const line of opt1Lines) {
    page.drawText(line, { x: LM + 38, y, size: FS, font: regular })
    y -= LH
  }
  y -= 2
  drawCheckbox(page, LM + 18, y, !isPax)
  const opt2Lines = wrapText('can only be transported on all-cargo aircraft because it originated from an unknown shipper and is screened at 100 percent', regular, FS, CW - 38)
  for (const line of opt2Lines) {
    page.drawText(line, { x: LM + 38, y, size: FS, font: regular })
    y -= LH
  }
  y -= 8

  // ── Custody method checkboxes ──
  const isSeal = doData.custody_method === 'seal'
  const isEscort = doData.custody_method === 'escort'
  const isLocked = doData.custody_method === 'locked_vehicle'

  page.drawText('Check the applicable box below:', { x: LM, y, size: FS, font: regular })
  y -= LH + 2
  drawCheckbox(page, LM + 18, y, isLocked)
  page.drawText('Locked vehicle', { x: LM + 33, y, size: FS, font: regular })
  y -= LH + 2
  drawCheckbox(page, LM + 18, y, isSeal)
  page.drawText('Tamper evident numbered seal \u2014', { x: LM + 33, y, size: FS, font: regular })
  if (isSeal && doData.seal_number) {
    const sealX = LM + 33 + regular.widthOfTextAtSize('Tamper evident numbered seal \u2014 ', FS)
    page.drawText(doData.seal_number, { x: sealX, y, size: FS, font: regular })
  }
  y -= LH + 2

  // ── Escort ──
  drawCheckbox(page, LM + 18, y, isEscort)
  const escortText = wrapText('If an escort is used, write the name of the escort associated with this cargo shipment below', regular, FS, CW - 38)
  for (const line of escortText) {
    page.drawText(line, { x: LM + 38, y, size: FS, font: regular })
    y -= LH
  }
  if (isEscort && doData.escort_name) {
    page.drawText(doData.escort_name, { x: LM, y, size: FS, font: regular })
  }
  y -= LH; hline(LM, LM + 200); y -= LH
  page.drawText('(Print name of escort)', { x: LM + 18, y, size: 8, font: regular })
  y -= LH + 8

  // ── Certification signature ──
  page.drawText('Name and signature of employee or authorized representative attesting to the above certification:', { x: LM, y, size: FS, font: regular })
  y -= LH + 2
  // For Merflex: rep_name is always used (e.g. "Carlos Villegas"); fallback to mcl_agent only if not set
  const repName = clientInfo.rep_name || doData.mcl_agent || ''
  if (repName) {
    page.drawText(repName, { x: LM, y, size: FS, font: regular })
  }
  // Embed signature image if available
  if (clientInfo.signature_url) {
    const sigResult = await embedClientLogo(pdfDoc, clientInfo.signature_url)
    if (sigResult) {
      const sigH = 25
      const sigW = sigH * (sigResult.img.width / sigResult.img.height)
      const sigX = LM + (repName ? regular.widthOfTextAtSize(repName, FS) + 10 : 0)
      page.drawImage(sigResult.img, { x: sigX, y: y - 8, width: sigW, height: sigH })
    }
  }
  page.drawText('(Sign and print name of employee or', { x: LM + 200, y, size: 8, font: regular })
  y -= LH
  page.drawText('authorized representative)', { x: LM, y, size: 8, font: regular })
  y -= 2; hline(LM, RM); y -= LH + 4

  // ── Company and driver ──
  page.drawText('Name of company and name of driver delivering the cargo shipment:', { x: LM, y, size: FS, font: regular })
  y -= LH + 2
  const companyDriver = [doData.trucking_company, doData.driver_name].filter(Boolean).join(' \u2014 ')
  if (companyDriver) { page.drawText(companyDriver, { x: LM, y, size: FS, font: regular }) }
  y -= LH + 2
  page.drawText('(Sign and print name of employee or authorized representative)', { x: LM, y, size: 8, font: regular })
  y -= LH + 8

  // ── Accepting entity ──
  const acceptText = wrapText(
    "Print name of the accepting entity's employee or authorized representative who is " +
    "verifying that the seal number written above matches the seal number on the conveyance " +
    "OR is verifying the government issued identification of the escort and ensuring the name " +
    "matches the name written above OR is verifying that the cargo arrived in a locked " +
    "conveyance.  Accepting Employee or Authorized Representative",
    regular, 9, CW,
  )
  for (const line of acceptText) {
    page.drawText(line, { x: LM, y, size: 9, font: regular })
    y -= 12
  }
  y -= 4; hline(LM, RM); y -= LH
  page.drawText('(Sign and print name of employee or authorized representative)', { x: LM, y, size: 8, font: regular })

  const bytes = await pdfDoc.save()
  return bytes.buffer as ArrayBuffer
}

// ── LB Checklist PDF (pure pdf-lib) ─────────────────────────────────────────

export async function buildLbChecklistPdfBuffer(doData: DeliveryOrder): Promise<ArrayBuffer> {
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([612, 792])
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const LM = 20, RM = 592, CW = RM - LM
  const FS = 9, FS_SM = 7, LH = 13
  let y = 755

  const awb = doData.awb_number || doData.awb_1st_leg || ''
  const isCao = doData.accepted_for === 'CAO'
  const isPax = doData.accepted_for === 'PAX'

  // Checkbox column positions for YES/NO*/N/A (right side, inside bordered box)
  const cbSize = 10
  const colYesCb = 505, colNoCb = 532, colNaCb = 559

  // ── AWB Information bordered table ──
  const tblL = 160, tblR = 500, tblTop = y + 2
  const rowH = 14
  // Header row
  page.drawRectangle({ x: tblL, y: y - rowH + 4, width: tblR - tblL, height: rowH, borderWidth: 0.7, borderColor: rgb(0, 0, 0), color: rgb(1, 1, 1) })
  const hdrText = 'AWB Information'
  const hdrW = bold.widthOfTextAtSize(hdrText, FS)
  page.drawText(hdrText, { x: tblL + (tblR - tblL - hdrW) / 2, y: y - 8, size: FS, font: bold })
  y -= rowH

  const infoRows = [
    `Date (MM / DD / YYYY):  ${fmtDate(doData.date)}`,
    `Master AWB #:  ${awb}`,
    `Destination:  ${doData.destination || ''}`,
  ]
  for (const row of infoRows) {
    page.drawRectangle({ x: tblL, y: y - rowH + 4, width: tblR - tblL, height: rowH, borderWidth: 0.7, borderColor: rgb(0, 0, 0), color: rgb(1, 1, 1) })
    page.drawText(row, { x: tblL + 4, y: y - 8, size: FS_SM, font: regular })
    y -= rowH
  }
  // Qty of Pieces row (split into sub-columns)
  page.drawRectangle({ x: tblL, y: y - rowH + 4, width: tblR - tblL, height: rowH, borderWidth: 0.7, borderColor: rgb(0, 0, 0), color: rgb(1, 1, 1) })
  page.drawText('Qty of Pieces:', { x: tblL + 4, y: y - 8, size: FS_SM, font: regular })
  page.drawText(`(ELI) ${doData.pieces || '______'}`, { x: tblL + 80, y: y - 8, size: FS_SM, font: regular })
  page.drawText('(ELM) ______', { x: tblL + 200, y: y - 8, size: FS_SM, font: regular })
  y -= rowH
  // Total AWB Weight
  page.drawRectangle({ x: tblL, y: y - rowH + 4, width: tblR - tblL, height: rowH, borderWidth: 0.7, borderColor: rgb(0, 0, 0), color: rgb(1, 1, 1) })
  page.drawText(`Total AWB Weight:  ${doData.weight || 0} kg`, { x: tblL + 4, y: y - 8, size: FS_SM, font: regular })
  y -= rowH

  // ── Accepted / Rejected / Hold (right of table) ──
  const accX = 520
  drawCheckbox(page, accX, tblTop - 10, true)
  page.drawText('Accepted', { x: accX + 14, y: tblTop - 10, size: FS, font: bold })
  drawCheckbox(page, accX, tblTop - 28, false)
  page.drawText('Rejected', { x: accX + 14, y: tblTop - 28, size: FS, font: regular })
  drawCheckbox(page, accX, tblTop - 46, false)
  page.drawText('Hold', { x: accX + 14, y: tblTop - 46, size: FS, font: regular })

  // ── Accepted for: CAO / PAX ──
  page.drawText('Accepted for:', { x: accX, y: y + 18, size: FS, font: bold })
  page.drawText('CAO', { x: accX, y: y + 4, size: FS, font: regular })
  drawCheckbox(page, accX + 22, y + 4, isCao)
  page.drawText('PAX', { x: accX + 50, y: y + 4, size: FS, font: regular })
  drawCheckbox(page, accX + 72, y + 4, isPax)

  y -= 20

  // ── Title ──
  const title = 'ACCEPTANCE CHECKLIST FOR LITHIUM ION / METAL BATTERIES - SECTION II'
  page.drawText(title, { x: LM, y, size: 10, font: bold })
  y -= 14
  page.drawText('Is the following information correct for each entry?', { x: LM, y, size: FS, font: bold })
  y -= LH
  page.drawText('Delete the non-applicable type unless both are carried.', { x: LM, y, size: FS, font: regular })
  y -= 16

  // ── Bordered checklist box ──
  const boxTop = y + 14

  // Air Waybill header
  page.drawText('Air Waybill', { x: LM + 4, y, size: FS, font: bold })
  page.drawText('YES', { x: colYesCb, y, size: FS, font: bold })
  page.drawText('NO*', { x: colNoCb, y, size: FS, font: bold })
  page.drawText('N/A', { x: colNaCb, y, size: FS, font: bold })
  y -= 3
  page.drawLine({ start: { x: LM, y }, end: { x: RM, y }, thickness: 0.7, color: rgb(0, 0, 0) })
  y -= LH

  // Item 1
  page.drawText('1.', { x: LM + 4, y, size: FS, font: regular })
  page.drawText('The current text is included on the AWB, in the "Nature and Quantity of Goods" box [applicable PI, Section II].', { x: 35, y, size: FS, font: regular })
  y -= LH
  page.drawText('-', { x: 42, y, size: FS, font: regular })
  page.drawText('Batteries of ION / METAL lithium, according to section II of the Packing Instruction 966 / 967 / 969 / 970.', { x: 53, y, size: FS, font: regular })
  // YES/NO checkboxes for item 1
  drawCheckbox(page, colYesCb + 2, y + 4, false)
  drawCheckbox(page, colNoCb + 2, y + 4, false)
  y -= LH + 2
  page.drawText('-', { x: 42, y, size: FS, font: regular })
  page.drawText('The packing instruction (circle the applicable one):', { x: 53, y, size: FS, font: regular })
  y -= 20

  // PI boxes — ION group (966, 967) then gap then METAL group (969, 970)
  const boxW = 44, boxH = 24, boxGap = 4, groupGap = 20
  const ionPIs = ['966', '967']
  const metalPIs = ['969', '970']

  const ionStartX = 160
  for (let i = 0; i < ionPIs.length; i++) {
    const bx = ionStartX + i * (boxW + boxGap)
    page.drawRectangle({ x: bx, y: y - 4, width: boxW, height: boxH, borderWidth: 0.7, borderColor: rgb(0, 0, 0), color: rgb(1, 1, 1) })
    const piLabel = `"PI:`
    const plw = regular.widthOfTextAtSize(piLabel, FS)
    page.drawText(piLabel, { x: bx + (boxW - plw) / 2, y: y + 8, size: FS, font: regular })
    const numLabel = `${ionPIs[i]}"`
    const nlw = regular.widthOfTextAtSize(numLabel, FS)
    page.drawText(numLabel, { x: bx + (boxW - nlw) / 2, y: y - 2, size: FS, font: regular })
  }
  const metalStartX = ionStartX + ionPIs.length * (boxW + boxGap) + groupGap
  for (let i = 0; i < metalPIs.length; i++) {
    const bx = metalStartX + i * (boxW + boxGap)
    page.drawRectangle({ x: bx, y: y - 4, width: boxW, height: boxH, borderWidth: 0.7, borderColor: rgb(0, 0, 0), color: rgb(1, 1, 1) })
    const piLabel = `"PI:`
    const plw = regular.widthOfTextAtSize(piLabel, FS)
    page.drawText(piLabel, { x: bx + (boxW - plw) / 2, y: y + 8, size: FS, font: regular })
    const numLabel = `${metalPIs[i]}"`
    const nlw = regular.widthOfTextAtSize(numLabel, FS)
    page.drawText(numLabel, { x: bx + (boxW - nlw) / 2, y: y - 2, size: FS, font: regular })
  }
  // YES/NO checkboxes for PI row
  drawCheckbox(page, colYesCb + 2, y + 4, false)
  drawCheckbox(page, colNoCb + 2, y + 4, false)
  y -= 16

  // ION / METAL labels
  const ionEnd = ionStartX + ionPIs.length * (boxW + boxGap) - boxGap
  const metalEnd = metalStartX + metalPIs.length * (boxW + boxGap) - boxGap
  const ionLblW = regular.widthOfTextAtSize('ION', FS)
  const metalLblW = regular.widthOfTextAtSize('METAL', FS)
  page.drawText('ION', { x: (ionStartX + ionEnd) / 2 - ionLblW / 2, y, size: FS, font: regular })
  page.drawText('METAL', { x: (metalStartX + metalEnd) / 2 - metalLblW / 2, y, size: FS, font: regular })
  y -= 14

  // ── Packages and Overpacks ──
  page.drawText('Packages and Overpacks', { x: LM + 4, y, size: FS, font: bold })
  y -= 3
  page.drawLine({ start: { x: LM, y }, end: { x: RM, y }, thickness: 0.7, color: rgb(0, 0, 0) })
  y -= LH

  // Item 2
  page.drawText('2.', { x: LM + 4, y, size: FS, font: regular })
  page.drawText('Packaging conforms with packing instructions and is free from damage, impacts or leakage [9.1.3.1.i].', { x: 35, y, size: FS, font: regular })
  drawCheckbox(page, colYesCb + 2, y, false)
  drawCheckbox(page, colNoCb + 2, y, false)
  y -= LH

  // Item 3
  page.drawText('3.', { x: LM + 4, y, size: FS, font: regular })
  page.drawText('Each package must be marked with a lithium battery handling mark and duly completed with the corresponding data [Figure 7.1.c].', { x: 35, y, size: FS, font: regular })
  drawCheckbox(page, colYesCb + 2, y, false)
  drawCheckbox(page, colNoCb + 2, y, false)
  y -= LH

  // Item 4
  page.drawText('4.', { x: LM + 4, y, size: FS, font: regular })
  page.drawText('The overpack must be marked with the word "Overpack" with a minimum height of 12 mm, and marked with the battery', { x: 35, y, size: FS, font: regular })
  drawCheckbox(page, colYesCb + 2, y, false)
  drawCheckbox(page, colNoCb + 2, y, false)
  y -= 10
  page.drawText('mark [Figure 7.1.c], unless the mark(s) on the package(s) inside the overpack are visible [7.1.7].', { x: 35, y, size: FS, font: regular })
  y -= 14

  // ── General ──
  page.drawText('General', { x: LM + 4, y, size: FS, font: bold })
  y -= 3
  page.drawLine({ start: { x: LM, y }, end: { x: RM, y }, thickness: 0.7, color: rgb(0, 0, 0) })
  y -= LH

  // Item 5
  page.drawText('5.', { x: LM + 6, y, size: FS, font: regular })
  page.drawText('State and Operator variations complied with [2.8].', { x: 35, y, size: FS, font: regular })
  drawCheckbox(page, colYesCb + 2, y, false)
  drawCheckbox(page, colNoCb + 2, y, false)
  drawCheckbox(page, colNaCb + 2, y, false)
  y -= LH

  // Item 6
  page.drawText('6.', { x: LM + 6, y, size: FS, font: regular })
  page.drawText('The PI 969 - 970, will only be transported in CAO ("Cargo Only"), in PAX prohibited except for exceptions according to', { x: 35, y, size: FS, font: regular })
  drawCheckbox(page, colYesCb + 2, y, false)
  drawCheckbox(page, colNoCb + 2, y, false)
  drawCheckbox(page, colNaCb + 2, y, false)
  y -= 11
  page.drawText('the current MOC 6.25.5.1.1 / Bol-CGO-LC 039.(Medical equipment for humanitarian purposes / Temperature control', { x: 35, y, size: FS, font: regular })
  y -= 10
  page.drawText('devices "data loggers" / Material from the LATAM group "COMAT")', { x: 35, y, size: FS, font: regular })

  const boxBottom = y - 8

  // Draw outer border for entire checklist
  page.drawRectangle({
    x: LM, y: boxBottom, width: CW, height: boxTop - boxBottom,
    borderWidth: 1, borderColor: rgb(0, 0, 0), color: undefined,
  })
  y = boxBottom - 14

  // ── Observations ──
  page.drawText('Observations:', { x: LM, y, size: FS, font: bold })
  page.drawLine({ start: { x: LM, y: y - 26 }, end: { x: RM, y: y - 26 }, thickness: 0.5, color: rgb(0, 0, 0) })
  page.drawLine({ start: { x: LM, y: y - 44 }, end: { x: RM, y: y - 44 }, thickness: 0.5, color: rgb(0, 0, 0) })
  y -= 64

  // ── Checked by / Place / Date-Time ──
  const sigY = y
  const col1 = LM, col2 = 230, col3 = 430

  page.drawText('Date /', { x: col3, y: sigY + 12, size: FS, font: bold })
  page.drawText('Time', { x: col3, y: sigY + 2, size: FS, font: bold })

  page.drawText('Checked by', { x: col1, y: sigY, size: FS, font: bold })
  page.drawText('Place:', { x: col2, y: sigY, size: FS, font: bold })

  page.drawLine({ start: { x: col1, y: sigY - 18 }, end: { x: col2 - 20, y: sigY - 18 }, thickness: 0.5, color: rgb(0, 0, 0) })
  page.drawLine({ start: { x: col2, y: sigY - 18 }, end: { x: col3 - 20, y: sigY - 18 }, thickness: 0.5, color: rgb(0, 0, 0) })
  page.drawLine({ start: { x: col3, y: sigY - 18 }, end: { x: RM, y: sigY - 18 }, thickness: 0.5, color: rgb(0, 0, 0) })
  page.drawText('Legible Name and Signature', { x: col1 + 20, y: sigY - 28, size: FS, font: regular })
  y = sigY - 46

  // ── Footer disclaimer ──
  page.drawText('* IF ANY BOX IS CHECKED "NO", DO NOT ACCEPT THE SHIPMENT AND GIVE A DUPLICATE COPY OF THIS COMPLETED FORM TO THE', { x: LM, y, size: FS_SM, font: regular })
  page.drawText('SHIPPER.', { x: LM, y: y - 9, size: FS_SM, font: regular })

  // REV
  const revText = 'REV 00/2025'
  const revW = regular.widthOfTextAtSize(revText, FS_SM)
  page.drawText(revText, { x: RM - revW, y, size: FS_SM, font: regular, color: rgb(0.4, 0.4, 0.4) })

  const bytes = await pdfDoc.save()
  return bytes.buffer as ArrayBuffer
}

// ── Config-driven Set Assembly ──────────────────────────────────────────────

export interface SetDocEntry {
  key: string
  copies: number
}

/**
 * Generic config-driven set builder.
 * @param entries  Ordered list of doc keys + copies from Firestore config
 * @param buffers  Map of doc key → ArrayBuffer (null/undefined = skip)
 */
export async function buildSetFromConfig(
  entries: SetDocEntry[],
  buffers: Record<string, ArrayBuffer | null | undefined>,
): Promise<ArrayBuffer> {
  const items: { buffer: ArrayBuffer; copies?: number }[] = []
  for (const entry of entries) {
    const buf = buffers[entry.key]
    if (buf) items.push({ buffer: buf, copies: entry.copies })
  }
  if (items.length === 0) throw new Error('Set vacio: ningun documento disponible')
  return mergePdfBuffers(items)
}

// ── Set Assembly (legacy hardcoded) ─────────────────────────────────────────

interface SetDocs {
  ccsfBuffer: ArrayBuffer
  ccssspBuffer: ArrayBuffer | null // CCSSSP (client security program) — goes after CCSF
  lbBuffer: ArrayBuffer | null     // null if no battery
  doTsaBuffer: ArrayBuffer | null
  doc7512Buffer: ArrayBuffer | null
  hawbBuffer: ArrayBuffer | null   // full AWB PDF
  copy5Buffer: ArrayBuffer | null  // penultimate page of AWB
  manifestoBuffer: ArrayBuffer | null
}

export async function buildSetCounter(docs: SetDocs): Promise<ArrayBuffer> {
  const items: { buffer: ArrayBuffer; copies?: number }[] = []
  items.push({ buffer: docs.ccsfBuffer, copies: 1 })
  if (docs.ccssspBuffer) items.push({ buffer: docs.ccssspBuffer, copies: 1 })
  if (docs.doTsaBuffer) items.push({ buffer: docs.doTsaBuffer, copies: 1 })
  if (docs.lbBuffer) items.push({ buffer: docs.lbBuffer, copies: 1 })
  if (docs.doc7512Buffer) items.push({ buffer: docs.doc7512Buffer, copies: 1 })
  if (docs.hawbBuffer) items.push({ buffer: docs.hawbBuffer, copies: 1 })
  return mergePdfBuffers(items)
}

export async function buildSetDriver(docs: SetDocs): Promise<ArrayBuffer> {
  const items: { buffer: ArrayBuffer; copies?: number }[] = []
  items.push({ buffer: docs.ccsfBuffer, copies: 2 })
  if (docs.ccssspBuffer) items.push({ buffer: docs.ccssspBuffer, copies: 2 })
  if (docs.lbBuffer) items.push({ buffer: docs.lbBuffer, copies: 1 })
  if (docs.copy5Buffer) items.push({ buffer: docs.copy5Buffer, copies: 1 })
  return mergePdfBuffers(items)
}

export async function buildSetEnvelope(docs: SetDocs): Promise<ArrayBuffer> {
  const items: { buffer: ArrayBuffer; copies?: number }[] = []
  if (docs.doc7512Buffer) items.push({ buffer: docs.doc7512Buffer, copies: 1 })
  if (docs.copy5Buffer) items.push({ buffer: docs.copy5Buffer, copies: 1 })
  if (docs.manifestoBuffer) items.push({ buffer: docs.manifestoBuffer, copies: 1 })
  return mergePdfBuffers(items)
}

// ── MAWB Set Assembly ──────────────────────────────────────────────────────

interface MawbSetDocs {
  ccsfBuffer: ArrayBuffer
  ccssspBuffer: ArrayBuffer | null
  lbBuffer: ArrayBuffer | null
  doTsaBuffer: ArrayBuffer | null
  manifestoBuffer: ArrayBuffer | null
  mawbBuffer: ArrayBuffer | null       // MAWB draft or def
  // Per-child AWB docs (one entry per selected HAWB)
  childDocs: {
    doc7512Buffer: ArrayBuffer | null
    hawbBuffer: ArrayBuffer | null
    copy5Buffer: ArrayBuffer | null
  }[]
}

// MAWB Counter: CCSF + CCSSSP + DO/TSA + LB + Manifesto + MAWB draft/def
export async function buildSetCounterMawb(docs: MawbSetDocs): Promise<ArrayBuffer> {
  const items: { buffer: ArrayBuffer; copies?: number }[] = []
  items.push({ buffer: docs.ccsfBuffer, copies: 1 })
  if (docs.ccssspBuffer) items.push({ buffer: docs.ccssspBuffer, copies: 1 })
  if (docs.doTsaBuffer) items.push({ buffer: docs.doTsaBuffer, copies: 1 })
  if (docs.lbBuffer) items.push({ buffer: docs.lbBuffer, copies: 1 })
  if (docs.manifestoBuffer) items.push({ buffer: docs.manifestoBuffer, copies: 1 })
  if (docs.mawbBuffer) items.push({ buffer: docs.mawbBuffer, copies: 1 })
  return mergePdfBuffers(items)
}

// MAWB Driver: CCSF×2 + CCSSSP×2 + LB + Copy5×N (each child)
export async function buildSetDriverMawb(docs: MawbSetDocs): Promise<ArrayBuffer> {
  const items: { buffer: ArrayBuffer; copies?: number }[] = []
  items.push({ buffer: docs.ccsfBuffer, copies: 2 })
  if (docs.ccssspBuffer) items.push({ buffer: docs.ccssspBuffer, copies: 2 })
  if (docs.lbBuffer) items.push({ buffer: docs.lbBuffer, copies: 1 })
  for (const child of docs.childDocs) {
    if (child.copy5Buffer) items.push({ buffer: child.copy5Buffer, copies: 1 })
  }
  return mergePdfBuffers(items)
}

// MAWB Envelope: 7512×N + HAWB×N (each child)
export async function buildSetEnvelopeMawb(docs: MawbSetDocs): Promise<ArrayBuffer> {
  const items: { buffer: ArrayBuffer; copies?: number }[] = []
  for (const child of docs.childDocs) {
    if (child.doc7512Buffer) items.push({ buffer: child.doc7512Buffer, copies: 1 })
    if (child.hawbBuffer) items.push({ buffer: child.hawbBuffer, copies: 1 })
  }
  return mergePdfBuffers(items)
}

// ── Export Set Assembly ─────────────────────────────────────────────────────

interface ExportSetDocs {
  ccsfBuffer: ArrayBuffer
  ccssspBuffer: ArrayBuffer | null
  lbBuffer: ArrayBuffer | null
  doBuffer: ArrayBuffer | null         // Delivery Order (line-level)
  tsaLetterBuffer: ArrayBuffer | null  // TSA Letter (line-level)
  doc7512Buffer: ArrayBuffer | null
  hawbBuffer: ArrayBuffer | null       // full AWB PDF
  copy5Buffer: ArrayBuffer | null      // penultimate page of AWB
  manifestoBuffer: ArrayBuffer | null  // flight-level
}

// Export Counter: CCSF + CCSSSP + DO + TSA Letter + LB + 7512 + AWB + Manifesto
export async function buildSetCounterExport(docs: ExportSetDocs): Promise<ArrayBuffer> {
  const items: { buffer: ArrayBuffer; copies?: number }[] = []
  items.push({ buffer: docs.ccsfBuffer, copies: 1 })
  if (docs.ccssspBuffer) items.push({ buffer: docs.ccssspBuffer, copies: 1 })
  if (docs.doBuffer) items.push({ buffer: docs.doBuffer, copies: 1 })
  if (docs.tsaLetterBuffer) items.push({ buffer: docs.tsaLetterBuffer, copies: 1 })
  if (docs.lbBuffer) items.push({ buffer: docs.lbBuffer, copies: 1 })
  if (docs.doc7512Buffer) items.push({ buffer: docs.doc7512Buffer, copies: 1 })
  if (docs.hawbBuffer) items.push({ buffer: docs.hawbBuffer, copies: 1 })
  if (docs.manifestoBuffer) items.push({ buffer: docs.manifestoBuffer, copies: 1 })
  return mergePdfBuffers(items)
}

// Export Driver: CCSF×2 + CCSSSP×2 + LB + Copy5
export async function buildSetDriverExport(docs: ExportSetDocs): Promise<ArrayBuffer> {
  const items: { buffer: ArrayBuffer; copies?: number }[] = []
  items.push({ buffer: docs.ccsfBuffer, copies: 2 })
  if (docs.ccssspBuffer) items.push({ buffer: docs.ccssspBuffer, copies: 2 })
  if (docs.lbBuffer) items.push({ buffer: docs.lbBuffer, copies: 1 })
  if (docs.copy5Buffer) items.push({ buffer: docs.copy5Buffer, copies: 1 })
  return mergePdfBuffers(items)
}

// Export Envelope: 7512 + Copy5 + Manifesto
export async function buildSetEnvelopeExport(docs: ExportSetDocs): Promise<ArrayBuffer> {
  const items: { buffer: ArrayBuffer; copies?: number }[] = []
  if (docs.doc7512Buffer) items.push({ buffer: docs.doc7512Buffer, copies: 1 })
  if (docs.copy5Buffer) items.push({ buffer: docs.copy5Buffer, copies: 1 })
  if (docs.manifestoBuffer) items.push({ buffer: docs.manifestoBuffer, copies: 1 })
  return mergePdfBuffers(items)
}
