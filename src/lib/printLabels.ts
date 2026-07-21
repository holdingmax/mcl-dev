import JsBarcode from 'jsbarcode'
import { WarehouseReceipt, WRLine, WSServiceType } from '../types'
import { fmtNum } from './utils'

function makeSVGBarcode(data: string): string {
  try {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    JsBarcode(svg, data, {
      format: 'CODE128',
      width: 2.2,
      height: 90,
      fontSize: 11,
      margin: 4,
      displayValue: true,
    })
    return svg.outerHTML
  } catch {
    return `<div style="font-size:8pt">${data}</div>`
  }
}

const WS_SERVICE_LABELS: Record<string, string> = {
  screening_k9: 'Screening K9',
  screening_xray: 'Screening X-Ray',
  screening_manual: 'Screening Manual',
  transport: 'Transport',
  storage: 'Storage',
  in_out: 'In/Out',
  repack: 'Repack',
  dg_inspection: 'DG Inspection',
  handling_storage_fee: 'Handling/Storage Fee',
}

export function printLabels(
  wr: WarehouseReceipt,
  lines: WRLine[],
  lineIndex?: number,
  wsServices?: WSServiceType[],
) {
  const logoUrl        = `${window.location.origin}/logo.png`
  const isWS           = wr.source === 'warehouse_services'
  const warehouseNum   = (wr.wr_number || '').replace(/^LI/, '')
  const soNumber       = wr.so_number || ''
  const awbNumber      = wr.awb_number || ''
  const po             = wr.po_number || ''
  const poPrefix       = po.length > 4 ? po.slice(0, -4) : ''
  const poSuffix       = po.slice(-4)
  const servicesText   = (wsServices || []).map(s => WS_SERVICE_LABELS[s] || s).join(' | ')

  const now     = new Date()
  const dateStr = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`

  const labelsHTML: string[] = []
  let globalPiece = 1

  lines.forEach((line, idx) => {
    const qty = line.qty || 1
    for (let p = 0; p < qty; p++) {
      if (lineIndex === undefined || lineIndex === idx) {
        const pieceNum       = globalPiece + p
        const pieceStr       = String(pieceNum).padStart(2, '0')
        const barcodeData    = isWS
          ? wr.wr_number + pieceStr
          : warehouseNum + pieceStr + poSuffix
        const weightPerPiece = line.weight_kg != null ? fmtNum(line.weight_kg / qty) : '—'
        const barcodeSVG     = makeSVGBarcode(barcodeData)

        labelsHTML.push(`
<div class="label">
  <div class="header">
    <div class="hl">
      <img src="${logoUrl}" />
      <div class="meta">
        <div><b>FROM:</b> ${wr.from_port || 'MIA'}</div>
        <div><b>DATE:</b> ${dateStr}</div>
        <div><b>TIME:</b> ${timeStr}</div>
      </div>
    </div>
    <div class="dest">${wr.to_port || ''}</div>
  </div>
  <hr/>
  <div class="wh-row">
    <span class="wh-lbl">Warehouse No.</span>
    <span class="wh-num">${warehouseNum}</span>
  </div>
  ${isWS ? `
  <div class="mid">
    <div class="client-block">
      <div class="client-name">${wr.client_name || wr.company_name || ''}</div>
      ${servicesText ? `<div class="ws-services">${servicesText}</div>` : ''}
    </div>
    <div class="piece">${pieceStr}</div>
  </div>` : `
  <div class="mid">
    <div class="parties">
      <div><b>SHIPPER:</b> ${wr.company_name || ''}</div>
      <div><b>CONSIGNEE:</b> ${wr.consignee?.name || '—'}</div>
    </div>
    <div class="piece">${pieceStr}</div>
  </div>`}
  <hr/>
  ${isWS ? `
  <div class="po-sec">
    <div class="po-lbl"><b>SO#</b></div>
    <div class="po-num">
      <span class="po-suf" style="font-size:28pt">${soNumber}</span>
    </div>
    <div class="ws-refs">
      ${po ? `<span><b>PO:</b> ${po}</span>` : ''}
      ${awbNumber ? `<span><b>AWB:</b> ${awbNumber}</span>` : ''}
    </div>
  </div>` : `
  <div class="po-sec">
    <div class="po-lbl"><b>PO#</b></div>
    <div class="po-num">
      <span class="po-pre">${poPrefix}</span><span class="po-suf">${poSuffix}</span>
    </div>
  </div>`}
  <hr/>
  <div class="pw">
    <div><span class="pw-n">1</span> Pcs.</div>
    <div class="pw-w">${weightPerPiece} KG</div>
  </div>
  <div class="bc">${barcodeSVG}</div>
</div>`)
      }
    }
    globalPiece += qty
  })

  if (labelsHTML.length === 0) {
    alert('No hay líneas para imprimir.')
    return
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Etiquetas ${wr.wr_number}</title>
<style>
@page{size:12cm 15cm;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;background:#fff}
.label{width:12cm;height:15cm;padding:.35cm .4cm;page-break-after:always;display:flex;flex-direction:column;overflow:hidden}
hr{border:none;border-top:1.5px solid #000;margin:.18cm 0}
.header{display:flex;justify-content:space-between;align-items:flex-start}
.hl img{height:2.7cm;object-fit:contain}
.meta{font-size:7.5pt;margin-top:.1cm;line-height:1.5}
.dest{font-size:58pt;font-weight:900;line-height:1;letter-spacing:-1px;align-self:center}
.wh-row{font-size:7.5pt;margin-bottom:.1cm}
.wh-num{font-size:10.5pt;font-weight:700}
.mid{display:flex;justify-content:space-between;align-items:stretch;margin-bottom:.1cm}
.parties{font-size:15pt;line-height:1.8;flex:1}
.client-block{flex:1}
.client-name{font-size:15pt;font-weight:700;line-height:1.3}
.ws-services{font-size:7.5pt;color:#555;margin-top:.1cm;line-height:1.4}
.piece{border:2.5px solid #000;min-width:1.5cm;display:flex;align-items:center;justify-content:center;font-size:22pt;font-weight:900;margin-left:.2cm;padding:0 .2cm}
.po-sec{margin-bottom:.06cm}
.po-lbl{font-size:7.5pt;margin-bottom:.03cm}
.po-num{display:flex;align-items:baseline;gap:.1cm}
.po-pre{font-size:13pt;font-weight:700}
.po-suf{font-size:38pt;font-weight:900;line-height:1}
.ws-refs{display:flex;gap:.5cm;font-size:12pt;margin-top:.3cm}
.pw{display:flex;justify-content:space-between;align-items:baseline}
.pw-n{font-size:18pt;font-weight:700}
.pw-w{font-size:20pt;font-weight:700}
.bc{margin-top:auto;flex-shrink:0;display:flex;justify-content:center}
.bc svg{max-width:100%}
</style></head>
<body>${labelsHTML.join('')}
<script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script>
</body></html>`

  const win = window.open('', '_blank', 'width=520,height=700')
  if (!win) {
    alert('Permite ventanas emergentes para imprimir etiquetas.')
    return
  }
  win.document.write(html)
  win.document.close()
}
