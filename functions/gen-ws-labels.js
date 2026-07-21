const admin = require('firebase-admin')
const fs = require('fs')
const path = require('path')

// Use firebase CLI's ADC credentials (Windows: AppData/Roaming/firebase)
const credPath = path.join(process.env.APPDATA || path.join(process.env.HOME || process.env.USERPROFILE, 'AppData', 'Roaming'), 'firebase', 'diego_garcia_mincurllogistics.com_application_default_credentials.json')

process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath
console.log('Using credentials:', credPath)

if (!admin.apps.length) admin.initializeApp({ projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  console.log('Fetching service orders...')
  const soSnap = await db.collection('warehouse_service_orders').get()
  const orders = soSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  console.log(`Found ${orders.length} service orders`)

  const labels = []

  for (const so of orders) {
    let wr = null
    let totalQty = so.declared_pieces || 0
    let totalWeight = so.declared_weight || null

    if (so.wr_id) {
      try {
        const wrSnap = await db.collection('warehouse_receipts').doc(so.wr_id).get()
        if (wrSnap.exists) {
          wr = { id: wrSnap.id, ...wrSnap.data() }
          totalQty = wr.total_qty || totalQty
          totalWeight = wr.total_weight_kg || totalWeight
        }
      } catch (e) { console.warn('WR error:', e.message) }
    }

    const wrNumber = wr ? (wr.wr_number || '') : '(sin WR)'
    const warehouseNum = wrNumber.replace(/^WS-/, '')
    const soNumber = so.so_number || ''
    const awbNumber = so.awb_number || (wr && wr.awb_number) || ''
    const po = so.reference || (wr && wr.po_number) || ''
    const clientName = so.client_name || (wr && wr.company_name) || ''
    const consignee = (wr && wr.consignee_name) || '—'
    const weightStr = totalWeight != null ? Number(totalWeight).toFixed(1) : '—'
    const barcodeText = wrNumber + '01'

    labels.push(`
  <div class="label-wrapper">
    <div class="label-info">
      <span>${soNumber}</span>
      <span>${wrNumber}</span>
      <span>${so.global_status || '?'}</span>
    </div>
    <div class="label">
      <div class="header">
        <div class="hl">
          <img src="https://wms-mcl.web.app/logo.png" />
          <div class="meta">
            <div><b>FROM:</b> MIA</div>
            <div><b>DATE:</b> ${new Date().toLocaleDateString('en-US',{month:'2-digit',day:'2-digit',year:'numeric'})}</div>
            <div><b>TIME:</b> ${new Date().toLocaleTimeString('en-US',{hour12:false})}</div>
          </div>
        </div>
        <div class="dest"></div>
      </div>
      <hr/>
      <div class="wh-row">
        <span class="wh-lbl">Warehouse No.</span>
        <span class="wh-num">${warehouseNum}</span>
      </div>
      <div class="mid">
        <div class="parties">
          <div><b>SHIPPER:</b> ${clientName}</div>
          <div><b>CONSIGNEE:</b> ${consignee}</div>
        </div>
        <div class="piece">${String(totalQty || 1).padStart(2, '0')}</div>
      </div>
      <hr/>
      <div class="po-sec">
        <div class="po-lbl"><b>SO#</b></div>
        <div class="po-num">
          <span class="po-suf">${soNumber}</span>
        </div>
        <div class="extra-info">
          ${po ? '<span><b>PO:</b> ' + po + '</span>' : ''}
          ${awbNumber ? '<span><b>AWB:</b> ' + awbNumber + '</span>' : ''}
        </div>
      </div>
      <hr/>
      <div class="pw">
        <div><span class="pw-n">${totalQty || '—'}</span> Pcs.</div>
        <div class="pw-w">${weightStr} KG</div>
      </div>
      <div class="bc">${barcodeText}</div>
    </div>
  </div>`)
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>WS Label Preview</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0 }
body { font-family: Arial, sans-serif; background: #f0f0f0; padding: 20px; display: flex; flex-wrap: wrap; gap: 24px; justify-content: center }
h1.title { width: 100%; text-align: center; font-size: 18pt; color: #333; margin-bottom: 10px }
p.subtitle { width: 100%; text-align: center; font-size: 10pt; color: #888; margin-bottom: 20px }
.label-wrapper { background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.15); border-radius: 4px; overflow: hidden }
.label-info { background: #1e3a5f; color: #fff; padding: 6px 12px; font-size: 8pt; display: flex; justify-content: space-between; gap: 12px }
.label { width: 12cm; height: 15cm; padding: .35cm .4cm; display: flex; flex-direction: column; overflow: hidden; background: #fff }
hr { border: none; border-top: 1.5px solid #000; margin: .18cm 0 }
.header { display: flex; justify-content: space-between; align-items: flex-start }
.hl img { height: 2.7cm; object-fit: contain }
.meta { font-size: 7.5pt; margin-top: .1cm; line-height: 1.5 }
.wh-row { font-size: 7.5pt; margin-bottom: .1cm }
.wh-num { font-size: 10.5pt; font-weight: 700 }
.mid { display: flex; justify-content: space-between; align-items: stretch; margin-bottom: .1cm }
.parties { font-size: 15pt; line-height: 1.8; flex: 1 }
.piece { border: 2.5px solid #000; min-width: 1.5cm; display: flex; align-items: center; justify-content: center; font-size: 22pt; font-weight: 900; margin-left: .2cm; padding: 0 .2cm }
.po-sec { margin-bottom: .06cm }
.po-lbl { font-size: 7.5pt; margin-bottom: .03cm }
.po-num { display: flex; align-items: baseline; gap: .1cm }
.po-suf { font-size: 28pt; font-weight: 900; line-height: 1 }
.pw { display: flex; justify-content: space-between; align-items: baseline }
.pw-n { font-size: 18pt; font-weight: 700 }
.pw-w { font-size: 20pt; font-weight: 700 }
.bc { margin-top: auto; flex-shrink: 0; display: flex; justify-content: center; font-family: monospace; font-size: 12pt; padding: 12px; border: 1px dashed #ccc; text-align: center; color: #333 }
.extra-info { display: flex; gap: .5cm; font-size: 8pt; margin-top: .08cm }
</style></head>
<body>
<h1 class="title">WS Label Preview</h1>
<p class="subtitle">${labels.length} Service Orders encontradas</p>
${labels.join('')}
</body></html>`

  const outPath = path.join(__dirname, '..', 'ws-label-preview.html')
  fs.writeFileSync(outPath, html)
  console.log(`Done! Generated ws-label-preview.html with ${labels.length} labels`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
