import type { AvDeliveryOrder, AvFlightAwb } from '../types'

function fmtDate(d: string): string {
  if (!d) return ''
  const dt = new Date(d)
  return dt.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
}

interface AvDoForPdf {
  doData: AvDeliveryOrder & { id: string; driver_pin?: string; dispatched_by?: string }
  awbs: AvFlightAwb[]
  destination: string
}

export function buildAvDoHtml({ doData, awbs, destination }: AvDoForPdf): string {
  const isSeal = doData.custody_method === 'seal'
  const isEscort = doData.custody_method === 'escort'
  const custodyLabel = isSeal ? `Tamper Evident Seal — #${doData.seal_number || ''}`
    : isEscort ? 'Escort' : 'Locked Vehicle'

  const ulds = (doData.uld_numbers || []).filter(u => u.trim())
  const uldsInline = ulds.map(u =>
    `<span style="font-family:monospace;font-weight:600;background:#f0f4f8;padding:1px 6px;border-radius:3px;border:1px solid #d0d5dd;">${u}</span>`
  ).join(' ')

  // Match AWBs from the DO's awb_numbers list
  const doAwbs = (doData.awb_numbers || []).map(awbNum => {
    const awb = awbs.find(a => a.awb_number === awbNum)
    return {
      awb_number: awbNum,
      iac_name: awb?.iac_name || '',
    }
  })

  const awbRowsHtml = doAwbs.map(a =>
    `<tr>
      <td style="padding:3px 6px;border:1px solid #ccc;font-family:monospace;font-weight:700;font-size:8.5pt;letter-spacing:0.3px;">${a.awb_number}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;">${doData.do_number}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;">${fmtDate(doData.date)}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;">Avianca Cargo</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;">${destination}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;">${a.iac_name}</td>
      <td style="padding:3px 6px;border:1px solid #ccc;font-size:8.5pt;">${doData.flight_number}</td>
    </tr>`
  ).join('')

  const mclAgent = doData.dispatched_by || doData.mcl_agent || ''

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
    <div class="do-badge">${doData.do_number}</div>
  </div>

  <div class="title-bar">
    <h2>DELIVERY ORDER</h2>
    <div class="date">${fmtDate(doData.date)}</div>
  </div>

  <table class="awb-table">
    <thead><tr>
      <th>AWB</th><th>DO#</th><th>Fecha</th><th>Deliver To</th><th>Destino</th><th>Shipper</th><th>Vuelo</th>
    </tr></thead>
    <tbody>${awbRowsHtml}</tbody>
  </table>

  <div class="info-grid">
    <div class="info-cell">
      <div class="info-label">Trucking Company</div>
      <div class="info-value">${doData.trucking_company || ''}</div>
    </div>
    <div class="info-cell">
      <div class="info-label">Driver Name</div>
      <div class="info-value">${doData.driver_name || ''}</div>
    </div>
    <div class="info-cell">
      <div class="info-label">Chain of Custody</div>
      <div class="info-value">${custodyLabel}</div>
    </div>
  </div>

  <div class="section-title">ULDs Loaded</div>
  <div style="margin-bottom:8px;font-size:8.5pt;line-height:1.8;">${uldsInline}</div>

  <div class="section-title">MCL Agent</div>
  <div style="font-size:9pt;font-weight:600;margin-bottom:4px;">${mclAgent}</div>

  <div class="sig-section">
    <div class="sig-row">
      <div class="sig-block">
        <div class="sig-name">${mclAgent}</div>
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
    <span>${doData.do_number} — Generated ${new Date().toLocaleString('en-US')}</span>
  </div>
</body></html>`
}

export function openAvDoPrint(html: string, doNumber: string): void {
  const baseUrl = window.location.origin
  const resolved = html.replace(/src="\/logo\.png"/g, `src="${baseUrl}/logo.png"`)
  const win = window.open('', '_blank')
  if (!win) { alert('Popup bloqueado. Permite popups para este sitio.'); return }
  win.document.write(resolved)
  win.document.close()
  win.document.title = `DO ${doNumber}`
}
