import { doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs, runTransaction } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from './firebase'
import { PickupOrder, PickupOrderLine } from '../types'

// ── PU# Sequence ────────────────────────────────────────────────────────────

export async function getNextPuNumber(): Promise<string> {
  const seqRef = doc(db, 'config', 'pu_sequence')
  const next = await runTransaction(db, async (tx) => {
    const snap = await tx.get(seqRef)
    const last = snap.exists() ? (snap.data().last_num || 0) : 0
    const n = last + 1
    tx.set(seqRef, { last_num: n }, { merge: true })
    return n
  })
  return `PU-${String(next).padStart(7, '0')}`
}

// ── Firestore CRUD ──────────────────────────────────────────────────────────

function stripUndefined(obj: Record<string, any>): Record<string, any> {
  const clean: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) clean[k] = v
  }
  return clean
}

export async function savePickupOrder(puData: PickupOrder): Promise<string> {
  if (puData.id) {
    const ref = doc(db, 'pickup_orders', puData.id)
    const { id: _id, ...rest } = puData
    await updateDoc(ref, stripUndefined({ ...rest, updated_at: new Date().toISOString() }) as any)
    return puData.id
  }
  // New — assign PU#
  const puNumber = await getNextPuNumber()
  const ref = doc(collection(db, 'pickup_orders'))
  const now = new Date().toISOString()
  const { id: _id, ...rest } = puData
  const toSave = stripUndefined({
    ...rest,
    pu_number: puNumber,
    created_at: now,
    status: 'draft',
  })
  await setDoc(ref, toSave)
  return ref.id
}

export async function loadPickupOrder(puId: string): Promise<(PickupOrder & { id: string }) | null> {
  const snap = await getDoc(doc(db, 'pickup_orders', puId))
  if (!snap.exists()) return null
  return { ...snap.data() as PickupOrder, id: snap.id }
}

// ── Authorization Letter Upload ──────────────────────────────────────────────

export async function uploadAuthorizationLetter(file: File, puId: string): Promise<string> {
  const path = `airfreight/pickup-orders/${puId}/auth-letter_${Date.now()}_${file.name}`
  const storageRef = ref(storage, path)
  await uploadBytes(storageRef, file)
  return getDownloadURL(storageRef)
}

// ── HTML Template — Pick Up Order ───────────────────────────────────────────

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${mm}/${dd}/${yyyy}`
}

function fmtDateTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export function buildPuHtml(puData: PickupOrder): string {
  const lines = puData.lines || []

  const lineRowsHtml = lines.map(l =>
    `<tr>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;">${l.client}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;">${l.client_document}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-family:monospace;font-weight:700;font-size:8.5pt;letter-spacing:0.3px;">${l.awb}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;">${l.pmc}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;text-align:center;">${l.pieces}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;text-align:right;">${l.weight}</td>
    </tr>`
  ).join('')

  const totalPieces = lines.reduce((s, l) => s + (l.pieces || 0), 0)
  const totalWeight = lines.reduce((s, l) => s + (l.weight || 0), 0)

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { margin: 0.4in 0.5in; size: letter; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .no-print { display: none !important; } }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 9pt; color: #1a1a1a; padding: 20px 30px; background: #fff; }
  .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #1a3a6b; padding-bottom: 8px; margin-bottom: 8px; }
  .company-sub { font-size: 7pt; color: #666; margin-top: 1px; }
  .pu-badge { background: #1a3a6b; color: #fff; font-size: 11pt; font-weight: 800; padding: 5px 14px; border-radius: 5px; letter-spacing: 1px; }
  .title-bar { background: #f0f4f8; padding: 6px 10px; border-radius: 4px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
  .title-bar h2 { font-size: 10pt; font-weight: 700; color: #1a3a6b; }
  .title-bar .date { font-size: 9pt; color: #555; }
  .pu-table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  .pu-table th { background: #1a3a6b; color: #fff; padding: 3px 6px; font-size: 7pt; text-transform: uppercase; letter-spacing: 0.5px; text-align: left; }
  .pu-table td { border: 1px solid #ccc; }
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
  .totals { font-size: 8pt; text-align: right; margin-bottom: 8px; color: #555; }
  .totals b { color: #1a1a1a; }
</style>
</head><body>
  <button class="print-btn no-print" onclick="window.print()">Print</button>
  <div class="header">
    <div>
      <img src="/logo.png" style="height:36px;" alt="MinCurl Logistics">
      <div class="company-sub">2323 NW 82ND AVE, Miami FL 33122</div>
    </div>
    <div class="pu-badge">${puData.pu_number || 'PU-PENDING'}</div>
  </div>

  <div class="title-bar">
    <h2>PICK UP ORDER</h2>
    <div class="date">${fmtDate(puData.date)}</div>
  </div>

  <table class="pu-table">
    <thead><tr>
      <th>Client</th><th>Client Doc</th><th>AWB</th><th>ULD / BUP</th><th>Pcs</th><th>Kg</th>
    </tr></thead>
    <tbody>${lineRowsHtml}</tbody>
  </table>

  <div class="totals">Total: <b>${totalPieces}</b> pcs / <b>${totalWeight.toFixed(1)}</b> kg</div>

  <div class="info-grid">
    <div class="info-cell">
      <div class="info-label">Trucking Company</div>
      <div class="info-value">${puData.trucking_company || '\u2014'}</div>
    </div>
    <div class="info-cell">
      <div class="info-label">Driver Name</div>
      <div class="info-value">${puData.driver_name || '\u2014'}</div>
    </div>
    <div class="info-cell">
      <div class="info-label">Pickup Location</div>
      <div class="info-value">${puData.pickup_location || '\u2014'}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-cell">
      <div class="info-label">Pickup Date / Time</div>
      <div class="info-value">${fmtDateTime(puData.pickup_datetime)}</div>
    </div>
    <div class="info-cell">
      <div class="info-label">To</div>
      <div class="info-value">${puData.drop_off_location || '\u2014'}</div>
    </div>
    <div class="info-cell">
      <div class="info-label">MCL Agent</div>
      <div class="info-value">${puData.mcl_agent || '\u2014'}</div>
    </div>
  </div>

  ${puData.notes ? `
  <div class="section-title">Notes</div>
  <div style="font-size:8.5pt;margin-bottom:8px;white-space:pre-wrap;">${puData.notes}</div>
  ` : ''}

  <div class="sig-section">
    <div class="sig-row">
      <div class="sig-block">
        <div class="sig-name">${puData.mcl_agent || ''}</div>
        <div class="sig-line">MCL Agent Signature</div>
      </div>
      <div class="sig-block">
        <div class="sig-name">${puData.driver_name || ''}</div>
        <div class="sig-line">Driver Signature</div>
      </div>
      <div class="sig-block">
        <div class="sig-line">Date / Time</div>
      </div>
    </div>
  </div>

  <div class="footer">
    <span>MinCurl Logistics LLC — Pick Up Order</span>
    <span>${puData.pu_number || ''} — Generated ${new Date().toLocaleString('en-US')}</span>
  </div>
</body></html>`
}

export function openPrintableHtml(html: string, title: string) {
  const w = window.open('', '_blank')
  if (!w) { alert('Pop-up blocked. Please allow pop-ups for this site.'); return }
  w.document.write(html)
  w.document.title = title
  w.document.close()
}
