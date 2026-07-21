import { forwardRef } from 'react'
import Barcode from 'react-barcode'
import { WarehouseReceipt, WRLine } from '../types'
import { fmtNum } from '../lib/utils'

interface LabelDocumentProps {
  wr: WarehouseReceipt
  lines: WRLine[]
  lineIndex?: number // undefined = all lines, number = only that line
}

interface LabelData {
  line: WRLine
  pieceNum: number  // global piece number within WR
}

function buildLabels(lines: WRLine[], lineIndex?: number): LabelData[] {
  const result: LabelData[] = []
  let globalPiece = 1

  lines.forEach((line, idx) => {
    const qty = line.qty || 1
    for (let p = 0; p < qty; p++) {
      if (lineIndex === undefined || lineIndex === idx) {
        result.push({ line, pieceNum: globalPiece + p })
      }
    }
    globalPiece += qty
  })

  return result
}

const LabelDocument = forwardRef<HTMLDivElement, LabelDocumentProps>(
  ({ wr, lines, lineIndex }, ref) => {
    const warehouseNumeric = (wr.wr_number || '').replace(/^LI/, '')
    const po              = wr.po_number || ''
    const poPrefix        = po.slice(0, -4)
    const poSuffix        = po.slice(-4)
    const last4PO         = poSuffix

    const now     = new Date()
    const dateStr = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`

    const labels = buildLabels(lines, lineIndex)

    return (
      <div ref={ref}>
        {labels.map(({ line, pieceNum }, idx) => {
          const pieceStr       = String(pieceNum).padStart(2, '0')
          const barcodeData    = warehouseNumeric + pieceStr + last4PO
          const weightPerPiece = line.weight_kg != null ? line.weight_kg / (line.qty || 1) : null

          return (
            <div
              key={idx}
              style={{
                width: '12cm',
                minHeight: '15cm',
                pageBreakAfter: 'always',
                display: 'flex',
                flexDirection: 'column',
                padding: '0.35cm 0.4cm',
                fontFamily: 'Arial, sans-serif',
                boxSizing: 'border-box',
              }}
            >
              {/* ── HEADER: Logo + Destination ── */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <img src="/logo.png" alt="MINCURL" style={{ height: '2.7cm', objectFit: 'contain', objectPosition: 'left' }} />
                  <div style={{ fontSize: '7.5pt', marginTop: '0.12cm', lineHeight: 1.5 }}>
                    <div><strong>FROM:</strong> {wr.from_port || 'MIA'}</div>
                    <div><strong>DATE:</strong> {dateStr}</div>
                    <div><strong>TIME:</strong> {timeStr}</div>
                  </div>
                </div>
                <div style={{ fontSize: '60pt', fontWeight: 900, lineHeight: 1, letterSpacing: '-1px', alignSelf: 'center' }}>
                  {wr.to_port}
                </div>
              </div>

              <div style={{ borderTop: '1.5px solid #000', margin: '0.2cm 0' }} />

              {/* ── WAREHOUSE No. ── */}
              <div style={{ fontSize: '7.5pt', marginBottom: '0.1cm' }}>
                <strong>Warehouse No.</strong>{' '}
                <span style={{ fontSize: '10.5pt', fontWeight: 700 }}>{warehouseNumeric}</span>
              </div>

              {/* ── SHIPPER / CONSIGNEE + Piece box ── */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', marginBottom: '0.15cm' }}>
                <div style={{ fontSize: '15pt', lineHeight: 1.7, flex: 1 }}>
                  <div><strong>SHIPPER:</strong> {wr.company_name}</div>
                  <div><strong>CONSIGNEE:</strong> {wr.consignee?.name || '—'}</div>
                </div>
                <div style={{
                  border: '2.5px solid #000',
                  minWidth: '1.5cm',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '24pt',
                  fontWeight: 900,
                  marginLeft: '0.25cm',
                  padding: '0 0.2cm',
                }}>
                  {pieceStr}
                </div>
              </div>

              <div style={{ borderTop: '1.5px solid #000', margin: '0.15cm 0' }} />

              {/* ── PO# ── */}
              <div style={{ marginBottom: '0.1cm' }}>
                <div style={{ fontSize: '7.5pt', marginBottom: '0.05cm' }}><strong>PO#</strong></div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.2cm' }}>
                  <span style={{ fontSize: '13pt', fontWeight: 700 }}>{poPrefix}</span>
                  <span style={{ fontSize: '40pt', fontWeight: 900, lineHeight: 1 }}>{poSuffix}</span>
                </div>
              </div>

              <div style={{ borderTop: '1.5px solid #000', margin: '0.15cm 0' }} />

              {/* ── Pcs + Weight ── */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div>
                  <span style={{ fontSize: '18pt', fontWeight: 700 }}>1</span>
                  <span style={{ fontSize: '8pt' }}> Pcs.</span>
                </div>
                <div style={{ fontSize: '20pt', fontWeight: 700 }}>
                  {weightPerPiece != null ? fmtNum(weightPerPiece) : '—'} KG
                </div>
              </div>

              {/* ── Barcode ── */}
              <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'center', width: '100%', flexShrink: 0, border: '3px solid red' }}>
                <Barcode
                  value={barcodeData || '0000000000000000'}
                  width={2.2}
                  height={160}
                  fontSize={11}
                  margin={0}
                  displayValue
                />
              </div>
            </div>
          )
        })}
      </div>
    )
  }
)

LabelDocument.displayName = 'LabelDocument'
export default LabelDocument
