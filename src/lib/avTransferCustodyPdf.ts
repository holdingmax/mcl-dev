import type { AvDeliveryOrder } from '../types'

function fmtDate(d: string): string {
  if (!d) return ''
  const dt = new Date(d)
  return dt.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
}

interface PalletTagInfo {
  uld_id: string
  awb_number: string
  pieces: number
}

interface AvTransferForPdf {
  doData: AvDeliveryOrder & { id: string; driver_pin?: string; dispatched_by?: string }
  destination: string
  palletTags: PalletTagInfo[]
}

export function buildAvTransferHtml({ doData, destination, palletTags }: AvTransferForPdf): string {
  const sealNumber = doData.seal_number || ''
  const driverName = doData.driver_name || ''
  const truckingCompany = doData.trucking_company || ''
  const flightNumber = doData.flight_number || ''

  // Group AWBs by ULD from pallet tags
  const uldAwbMap = new Map<string, { awbs: string[]; totalPieces: number }>()
  for (const uld of doData.uld_numbers || []) {
    uldAwbMap.set(uld, { awbs: [], totalPieces: 0 })
  }
  for (const pt of palletTags) {
    const uldKey = (doData.uld_numbers || []).find(u => u === pt.uld_id)
    if (uldKey && uldAwbMap.has(uldKey)) {
      const entry = uldAwbMap.get(uldKey)!
      if (!entry.awbs.includes(pt.awb_number)) {
        entry.awbs.push(pt.awb_number)
      }
      entry.totalPieces += pt.pieces || 0
    }
  }

  const ulds = doData.uld_numbers || []
  const cargoRows = ulds.map((uld, i) => {
    const info = uldAwbMap.get(uld)
    const awbsHtml = info && info.awbs.length > 0
      ? info.awbs.map(a => `<span style="font-family:Consolas,monospace;font-size:8pt;">${a}</span>`).join(', ')
      : ''
    const pcsLabel = info && info.totalPieces > 0 ? ` <span style="font-size:7pt;color:#666;">(${info.totalPieces} pcs)</span>` : ''
    return `<tr>
      <td style="border:1px solid #999;padding:2px 6px;font-size:8.5pt;text-align:center;">${i + 1}</td>
      ${i === 0 ? `<td rowspan="${ulds.length}" style="border:1px solid #999;padding:2px 6px;font-size:9pt;font-weight:bold;vertical-align:middle;text-align:center;">${truckingCompany}</td>` : ''}
      <td style="border:1px solid #999;padding:2px 6px;font-family:Consolas,monospace;font-size:8.5pt;font-weight:700;text-align:center;">${uld}</td>
      <td style="border:1px solid #999;padding:2px 6px;text-align:left;padding-left:10px;">${awbsHtml}${pcsLabel}</td>
      ${i === 0 ? `<td rowspan="${ulds.length}" style="border:1px solid #999;padding:2px 6px;font-size:9pt;font-weight:bold;vertical-align:middle;text-align:center;color:#c8102e;">${sealNumber}</td>` : ''}
    </tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<style>
  @page { margin: 0.3in 0.4in; size: letter; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .no-print { display: none !important; } }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, 'Segoe UI', sans-serif; font-size: 8.5pt; color: #1a1a1a; padding: 16px 24px; background: #fff; }
  .print-btn { position: fixed; top: 10px; right: 10px; background: #c8102e; color: #fff; border: none; padding: 8px 18px; border-radius: 6px; font-size: 11pt; font-weight: 700; cursor: pointer; z-index: 100; }
  .print-btn:hover { background: #a00d24; }
</style>
</head><body>
<button class="print-btn no-print" onclick="window.print()">Imprimir</button>

<!-- HEADER -->
<div style="display:flex;align-items:stretch;border:1px solid #999;">
  <div style="width:110px;display:flex;align-items:center;justify-content:center;padding:6px 10px;border-right:1px solid #999;">
    <span style="font-size:28pt;font-weight:900;color:#c8102e;font-family:'Arial Black',Arial,sans-serif;letter-spacing:-1px;line-height:1;">AV</span>
  </div>
  <div style="width:140px;padding:6px 10px;border-right:1px solid #999;font-weight:bold;font-size:10pt;text-align:center;display:flex;align-items:center;justify-content:center;">Avianca Cargo</div>
  <div style="flex:1;text-align:center;font-weight:bold;font-size:9.5pt;padding:6px 10px;border-right:1px solid #999;display:flex;align-items:center;justify-content:center;">TRANSFERENCIA Y/O CUSTODIA DE LA CARGA<br>CARGO TRANSFER AND CUSTODY</div>
  <div style="width:160px;padding:4px 8px;font-size:7.5pt;font-weight:bold;text-align:center;display:flex;flex-direction:column;justify-content:center;">
    <div style="border-bottom:1px solid #ccc;padding:2px 0;">Fecha de Revision: 27/05/2022</div>
    <div style="padding:2px 0;">Rev: 00</div>
  </div>
</div>

<!-- DATE & ESCORT TYPE -->
<table style="width:100%;border-collapse:collapse;border:1px solid #999;border-top:none;">
  <tr>
    <td style="border:1px solid #999;padding:3px 6px;background:#d9d9d9;font-weight:bold;font-size:8pt;width:70px;text-align:center;">Date:</td>
    <td style="border:1px solid #999;padding:3px 6px;font-size:9pt;font-weight:600;width:110px;text-align:center;">${fmtDate(doData.date)}</td>
    <td style="border:1px solid #999;padding:3px 6px;background:#d9d9d9;font-weight:bold;font-size:8pt;width:90px;text-align:center;">Escort Type:</td>
    <td style="border:1px solid #999;padding:3px 6px;background:#d0d0d0;text-align:center;font-size:8pt;">Export cargo <b style="color:#c8102e;">X</b></td>
    <td style="border:1px solid #999;padding:3px 6px;text-align:center;font-size:8pt;width:80px;">Impo cargo</td>
    <td style="border:1px solid #999;padding:3px 6px;text-align:center;font-size:7pt;width:100px;">All cargo aircraft CAO</td>
    <td style="border:1px solid #999;padding:3px 6px;text-align:center;font-size:7pt;">Especify / Comat:</td>
  </tr>
</table>

<!-- DESCRIPTION SECTION -->
<div style="background:#a6a6a6;font-weight:bold;font-size:8pt;padding:3px 8px;border:1px solid #999;border-top:none;text-align:center;">Description of the custody and/or transfer process</div>

<table style="width:100%;border-collapse:collapse;border:1px solid #999;border-top:none;">
  <tr>
    <th style="border:1px solid #999;padding:3px 6px;background:#d9d9d9;font-size:7.5pt;font-weight:bold;">Origin Station</th>
    <th style="border:1px solid #999;padding:3px 6px;background:#d9d9d9;font-size:7.5pt;font-weight:bold;">Escort Start Time</th>
    <th style="border:1px solid #999;padding:3px 6px;background:#d9d9d9;font-size:7.5pt;font-weight:bold;">Location From</th>
    <th style="border:1px solid #999;padding:3px 6px;background:#d9d9d9;font-size:7.5pt;font-weight:bold;">Description<br>(Airline/Flight or Warehouse)</th>
    <th style="border:1px solid #999;padding:3px 6px;background:#d9d9d9;font-size:7.5pt;font-weight:bold;">Escort Finish Time</th>
    <th style="border:1px solid #999;padding:3px 6px;background:#d9d9d9;font-size:7.5pt;font-weight:bold;">Location To</th>
    <th style="border:1px solid #999;padding:3px 6px;background:#d9d9d9;font-size:7.5pt;font-weight:bold;">Description<br>(Airline/Flight or Warehouse)</th>
    <th style="border:1px solid #999;padding:3px 6px;background:#d9d9d9;font-size:7.5pt;font-weight:bold;">Destination<br>(Station)</th>
  </tr>
  <tr>
    <td rowspan="3" style="border:1px solid #999;padding:3px 6px;background:#d0d0d0;text-align:center;font-weight:bold;font-size:10pt;vertical-align:middle;">MIA</td>
    <td rowspan="3" style="border:1px solid #999;padding:3px 6px;"></td>
    <td style="border:1px solid #999;padding:3px 6px;font-size:8pt;">Aircraft</td>
    <td style="border:1px solid #999;padding:3px 6px;"></td>
    <td rowspan="3" style="border:1px solid #999;padding:3px 6px;"></td>
    <td style="border:1px solid #999;padding:3px 6px;font-size:8pt;">Aircraft</td>
    <td style="border:1px solid #999;padding:3px 6px;"></td>
    <td rowspan="3" style="border:1px solid #999;padding:3px 6px;background:#d0d0d0;text-align:center;font-weight:bold;font-size:10pt;vertical-align:middle;">${destination}</td>
  </tr>
  <tr>
    <td style="border:1px solid #999;padding:3px 6px;background:#d0d0d0;font-weight:bold;font-size:8pt;">Warehouse <b style="color:#c8102e;">X</b></td>
    <td style="border:1px solid #999;padding:3px 6px;font-weight:600;font-size:8.5pt;">MinCurl Logistics</td>
    <td style="border:1px solid #999;padding:3px 6px;background:#d0d0d0;font-weight:bold;font-size:8pt;">Warehouse <b style="color:#c8102e;">X</b></td>
    <td style="border:1px solid #999;padding:3px 6px;background:#d0d0d0;font-weight:bold;font-size:8.5pt;">AVIANCA CARGO</td>
  </tr>
  <tr>
    <td style="border:1px solid #999;padding:3px 6px;font-size:8pt;">Other</td>
    <td style="border:1px solid #999;padding:3px 6px;"></td>
    <td style="border:1px solid #999;padding:3px 6px;font-size:8pt;">Other</td>
    <td style="border:1px solid #999;padding:3px 6px;"></td>
  </tr>
</table>

<!-- CARGO INFORMATION -->
<div style="background:#a6a6a6;font-weight:bold;font-size:8pt;padding:3px 8px;border:1px solid #999;border-top:none;text-align:center;">Information (cargo custody and/or transfer)</div>

<table style="width:100%;border-collapse:collapse;border:1px solid #999;border-top:none;">
  <tr>
    <th style="border:1px solid #999;padding:3px 6px;background:#d9d9d9;font-size:7.5pt;font-weight:bold;width:35px;">No.</th>
    <th style="border:1px solid #999;padding:3px 6px;background:#d9d9d9;font-size:7.5pt;font-weight:bold;width:140px;">TRUCK NUMBER</th>
    <th style="border:1px solid #999;padding:3px 6px;background:#d9d9d9;font-size:7.5pt;font-weight:bold;width:130px;">ULD No.</th>
    <th style="border:1px solid #999;padding:3px 6px;background:#d9d9d9;font-size:7.5pt;font-weight:bold;">AWB / Pieces</th>
    <th style="border:1px solid #999;padding:3px 6px;background:#d9d9d9;font-size:7.5pt;font-weight:bold;width:180px;">Security Seal Number on Truck</th>
  </tr>
  ${cargoRows}
</table>

<!-- 100% SCREENED -->
<div style="background:#d9d9d9;font-weight:bold;font-size:8pt;padding:3px 8px;border:1px solid #999;border-top:none;text-align:center;">100% Screened</div>
<div style="border:1px solid #999;border-top:none;padding:8px 12px;text-align:center;">
  <div style="font-size:10pt;font-weight:bold;line-height:1.4;">
    All cargo associated with this transfer document has been handled and SCREENED at 100%<br>
    in accordance with the requirements established in the ACISP / SSPAC.
  </div>
</div>

<!-- SIGNATURES -->
<div style="background:#d9d9d9;font-weight:bold;font-size:8pt;padding:3px 8px;border:1px solid #999;border-top:none;text-align:center;">Information of the personnel responsible for the control, custody and/or transfer of the cargo</div>

<table style="width:100%;border-collapse:collapse;border:1px solid #999;border-top:none;">
  <tr>
    <td colspan="2" style="border:1px solid #999;font-weight:bold;text-align:center;font-size:8pt;padding:4px;">MINCURL — DISPATCHER</td>
    <td colspan="2" style="border:1px solid #999;font-weight:bold;text-align:center;font-size:8pt;padding:4px;">MINCURL — DRIVER</td>
    <td colspan="2" style="border:1px solid #999;font-weight:bold;text-align:center;font-size:8pt;padding:4px;">AVIANCA CARGO — SECURITY</td>
  </tr>
  <tr>
    <td style="border:1px solid #999;padding:3px 8px;font-weight:bold;font-size:7.5pt;width:60px;">Signature:</td>
    <td style="border:1px solid #999;min-width:140px;height:30px;"></td>
    <td style="border:1px solid #999;padding:3px 8px;font-weight:bold;font-size:7.5pt;width:60px;">Signature:</td>
    <td style="border:1px solid #999;min-width:140px;"></td>
    <td style="border:1px solid #999;padding:3px 8px;font-weight:bold;font-size:7.5pt;width:60px;">Signature:</td>
    <td style="border:1px solid #999;min-width:140px;"></td>
  </tr>
  <tr>
    <td style="border:1px solid #999;padding:3px 8px;font-weight:bold;font-size:7.5pt;">Name:</td>
    <td style="border:1px solid #999;padding:3px 8px;font-size:8.5pt;"></td>
    <td style="border:1px solid #999;padding:3px 8px;font-weight:bold;font-size:7.5pt;">Name:</td>
    <td style="border:1px solid #999;padding:3px 8px;font-size:8.5pt;font-weight:600;">${driverName}</td>
    <td style="border:1px solid #999;padding:3px 8px;font-weight:bold;font-size:7.5pt;">Name:</td>
    <td style="border:1px solid #999;padding:3px 8px;font-size:8.5pt;"></td>
  </tr>
  <tr>
    <td style="border:1px solid #999;padding:3px 8px;font-weight:bold;font-size:7.5pt;">Position:</td>
    <td style="border:1px solid #999;padding:3px 8px;font-size:8.5pt;">Dispatcher</td>
    <td style="border:1px solid #999;padding:3px 8px;font-weight:bold;font-size:7.5pt;">Position:</td>
    <td style="border:1px solid #999;padding:3px 8px;font-size:8.5pt;">Driver</td>
    <td style="border:1px solid #999;padding:3px 8px;font-weight:bold;font-size:7.5pt;">Position:</td>
    <td style="border:1px solid #999;padding:3px 8px;font-size:8.5pt;"></td>
  </tr>
  <tr>
    <td style="border:1px solid #999;padding:3px 8px;font-weight:bold;font-size:7.5pt;">Company:</td>
    <td style="border:1px solid #999;padding:3px 8px;font-size:8.5pt;">MinCurl Logistics</td>
    <td style="border:1px solid #999;padding:3px 8px;font-weight:bold;font-size:7.5pt;">Company:</td>
    <td style="border:1px solid #999;padding:3px 8px;font-size:8.5pt;font-weight:600;">${truckingCompany}</td>
    <td style="border:1px solid #999;padding:3px 8px;font-weight:bold;font-size:7.5pt;">Company:</td>
    <td style="border:1px solid #999;padding:3px 8px;font-size:8.5pt;">Avianca Cargo</td>
  </tr>
  <tr>
    <td colspan="2" style="border:1px solid #999;padding:4px 8px;font-size:6.5pt;color:#666;font-weight:bold;line-height:1.3;">Information who makes the first delivery of the Cargo from warehouse or aircraft</td>
    <td colspan="2" style="border:1px solid #999;padding:4px 8px;font-size:6.5pt;color:#666;font-weight:bold;line-height:1.3;">Information who makes the custody or moves the cargo from the warehouse or aircraft</td>
    <td colspan="2" style="border:1px solid #999;padding:4px 8px;font-size:6.5pt;color:#666;font-weight:bold;line-height:1.3;">Information who receives cargo in warehouse or aircraft</td>
  </tr>
</table>

<!-- SSI FOOTER -->
<div style="border:1px solid #999;border-top:none;padding:6px 10px;font-size:6pt;font-weight:bold;line-height:1.4;color:#333;">
  Sensitive Security Information<br>
  WARNING: This record contains sensitive security information that is controlled under 49 C.F.R. parts 15 and 1520. No part of this record may be disclosed to persons without a &quot;need to know,&quot; as defined in 49 C.F.R. parts 15 and 1520, except with the written permission of the administrator of the Transportation Security Administration or the Secretary of Transportation. Unauthorized release may result in civil penalties or other action. For U.S. government agencies, public disclosure governed by 5 U.S.C. 552 and 49 C.F.R. parts 15 and 1520.
</div>

<div style="margin-top:6px;display:flex;justify-content:space-between;font-size:6.5pt;color:#999;">
  <span>MinCurl Logistics LLC — CCSF# MIA.I.06.16.2025.588</span>
  <span>DO ${doData.do_number} — Vuelo ${flightNumber} — Generated ${new Date().toLocaleString('en-US')}</span>
</div>

</body></html>`
}

export function openAvTransferPrint(html: string, doNumber: string): void {
  const win = window.open('', '_blank')
  if (!win) { alert('Popup bloqueado. Permite popups para este sitio.'); return }
  win.document.write(html)
  win.document.close()
  win.document.title = `Transfer ${doNumber}`
}
