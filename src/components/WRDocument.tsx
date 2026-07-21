import { forwardRef } from 'react'
import { WarehouseReceipt, WRLine, SkuLine } from '../types'
import { formatWRDate, toTitleCase, fmtNum } from '../lib/utils'

interface WRDocumentProps {
  wr: WarehouseReceipt
  lines: WRLine[]
  skuLines?: SkuLine[]
  minRows?: number
}

const WRDocument = forwardRef<HTMLDivElement, WRDocumentProps>(({ wr, lines, skuLines = [], minRows = 20 }, ref) => {
  const totalQty  = lines.reduce((s, l) => s + (l.qty || 0), 0)
  const totalCbm  = lines.reduce((s, l) => s + (l.cbm || 0), 0)
  const totalWeight = lines.reduce((s, l) => s + (l.weight_kg || 0), 0)
  // SKU block: 2 gap rows + 1 row for nested table (header+colheader+data+total rendered inside)
  const skuRowsUsed = skuLines.length > 0 ? 3 : 0
  const emptyRowsCount = Math.max(0, minRows - lines.length - skuRowsUsed)

  const cell   = 'border border-gray-800 px-1 py-0.5 text-xs'
  const hdr    = `${cell} bg-gray-100 font-bold text-center`
  const lineCell = 'px-1 py-0.5 text-xs'
  const totalCell = 'border border-gray-800 px-1 py-0.5 text-xs'

  // Outer border styles for the data block (no internal lines)
  const borderL = '1px solid #1f2937'
  const borderR = '1px solid #1f2937'
  const borderB = '1px solid #1f2937'

  return (
    <div
      ref={ref}
      id="wr-print-area"
      style={{
        fontFamily: 'Arial, sans-serif',
        fontSize: '11px',
        backgroundColor: 'white',
        padding: '12mm 12mm',
        width: '8.5in',
        height: '11in',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* ── TOP HEADER ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', marginBottom: '10px' }}>
        <div />
        <img src="/logo.png" alt="MINCURL Logistics" style={{ width: '6cm', height: '3.75cm', objectFit: 'contain', objectPosition: 'center' }} />
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: 'Arial, sans-serif', fontSize: '26px', fontWeight: 700, letterSpacing: '2px', color: '#1A4D2E' }}>Warehouse Receipt</div>
          <div style={{ fontFamily: 'Arial, sans-serif', fontSize: '18px', fontWeight: 700, marginTop: '4px', color: '#1A4D2E' }}>{wr.wr_number || '—'}</div>
          <div style={{ fontFamily: 'Arial, sans-serif', fontSize: '9px', color: '#555', marginTop: '2px' }}>MIAMI, FLORIDA</div>
        </div>
      </div>

      {/* ── MAIN TABLE (9 columns throughout) ── */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px', flex: 1 }}>
        <colgroup>
          <col style={{ width: '10%' }} />
          <col style={{ width: '6%'  }} />
          <col style={{ width: '5%'  }} />
          <col style={{ width: '8%'  }} />
          <col style={{ width: '7%'  }} />
          <col style={{ width: '7%'  }} />
          <col style={{ width: '8%'  }} />
          <col style={{ width: '11%' }} />
          <col style={{ width: '24%' }} />
        </colgroup>
        <tbody>

          {/* ── INFO HEADER ROW ── */}
          <tr>
            <td className={hdr}>CONSIGNEE</td>
            <td className={hdr} colSpan={2}>SHIPPER / VENDOR</td>
            <td className={hdr}>#PO</td>
            <td className={hdr}>FROM</td>
            <td className={hdr}>TO</td>
            <td className={hdr}>STATUS</td>
            <td className={hdr} colSpan={2}>DATE / TIME</td>
          </tr>

          {/* ── INFO DATA ROW ── */}
          <tr>
            <td className={cell} style={{ verticalAlign: 'top' }}>{toTitleCase(wr.consignee?.name) || ''}</td>
            <td className={cell} colSpan={2} style={{ verticalAlign: 'top' }}>{toTitleCase(wr.company_name)}</td>
            <td className={cell} style={{ verticalAlign: 'top' }}>{wr.po_number}</td>
            <td className={`${cell} text-center`}>{wr.from_port || 'MIA'}</td>
            <td className={`${cell} text-center`}>{wr.to_port}</td>
            <td className={`${cell} text-center`}>{wr.status || 'LOCAL'}</td>
            <td className={cell} colSpan={2}>{wr.created_at ? formatWRDate(wr.created_at) : '—'}</td>
          </tr>

          {/* ── NOTIFY TO ── */}
          {wr.notify_to && (
            <tr>
              <td colSpan={2} className={hdr} style={{ verticalAlign: 'middle' }}>NOTIFY TO</td>
              <td colSpan={7} className={cell} style={{ verticalAlign: 'middle', whiteSpace: 'pre-wrap' }}>{wr.notify_to}</td>
            </tr>
          )}

          {/* ── LINE ITEMS HEADER ── */}
          <tr>
            <td className={hdr}>QTY</td>
            <td className={hdr} colSpan={2}>PACKING TYPE</td>
            <td className={hdr}>LENGTH</td>
            <td className={hdr}>WIDTH</td>
            <td className={hdr}>HEIGHT</td>
            <td className={hdr}>CBM</td>
            <td className={hdr}>WEIGHT</td>
            <td className={hdr}>LOCATION / REMARKS</td>
          </tr>

          {/* ── LINE ITEMS ── */}
          {lines.map((line, i) => {
            const isLast = i === lines.length - 1 && skuLines.length === 0 && emptyRowsCount === 0
            return (
              <tr key={i}>
                <td className={`${lineCell} text-center`} style={{ borderLeft: borderL, color: '#c8102e', fontWeight: 600, ...(isLast ? { borderBottom: borderB } : {}) }}>{line.qty}</td>
                <td className={lineCell} colSpan={2} style={isLast ? { borderBottom: borderB } : {}}>
                  {line.packing_type}{line.has_lb ? ' LB' : ''}{line.is_dg ? ' DG' : ''}
                </td>
                <td className={`${lineCell} text-right`} style={isLast ? { borderBottom: borderB } : {}}>{line.length_cm ?? ''}</td>
                <td className={`${lineCell} text-right`} style={isLast ? { borderBottom: borderB } : {}}>{line.width_cm ?? ''}</td>
                <td className={`${lineCell} text-right`} style={isLast ? { borderBottom: borderB } : {}}>{line.height_cm ?? ''}</td>
                <td className={`${lineCell} text-right`} style={isLast ? { borderBottom: borderB } : {}}>{line.cbm ?? ''}</td>
                <td className={`${lineCell} text-right`} style={isLast ? { borderBottom: borderB } : {}}>{line.weight_kg ? `${line.weight_kg} KG` : ''}</td>
                <td className={lineCell} style={{ borderRight: borderR, ...(isLast ? { borderBottom: borderB } : {}) }}>{[line.location, line.remarks].filter(Boolean).join(' — ')}</td>
              </tr>
            )
          })}

          {/* ── SKU DETAIL (centered, narrower, after 2-row gap) ── */}
          {skuLines.length > 0 && (
            <>
              {/* 2 empty rows as visual separator */}
              <tr><td colSpan={9} style={{ height: '18px', borderLeft: borderL, borderRight: borderR }}>&nbsp;</td></tr>
              <tr><td colSpan={9} style={{ height: '18px', borderLeft: borderL, borderRight: borderR }}>&nbsp;</td></tr>
              {/* SKU block: col 1 empty | cols 2-8 = SKU table | col 9 empty */}
              <tr>
                <td style={{ borderLeft: borderL }}></td>
                <td colSpan={7} style={{ padding: 0 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
                    <tbody>
                      <tr>
                        <td colSpan={4} className={hdr} style={{ textAlign: 'center', paddingTop: '4px', paddingBottom: '4px' }}>SKU DETAIL</td>
                      </tr>
                      <tr>
                        <td className={hdr} style={{ width: '30%' }}>SKU</td>
                        <td className={hdr} style={{ width: '30%' }}>VIN</td>
                        <td className={hdr} style={{ width: '20%' }}>RECEIVED QTY</td>
                        <td className={hdr} style={{ width: '20%' }}>CASE PACK</td>
                      </tr>
                      {skuLines.map((sk, i) => (
                        <tr key={`sku-${i}`}>
                          <td className={lineCell}>{sk.sku}</td>
                          <td className={lineCell}>{sk.vin}</td>
                          <td className={`${lineCell} text-right`}>{sk.received_qty}</td>
                          <td className={`${lineCell} text-right`}>{sk.case_pack}</td>
                        </tr>
                      ))}
                      <tr style={{ backgroundColor: '#e8e8e8' }}>
                        <td className={`${hdr}`} style={{ textAlign: 'left' }}>Total: {skuLines.length} líneas</td>
                        <td className={hdr}></td>
                        <td className={`${hdr} text-right`}>{skuLines.reduce((s, sk) => s + (sk.received_qty || 0), 0)}</td>
                        <td className={`${hdr} text-right`}>{skuLines.reduce((s, sk) => s + (sk.case_pack || 0), 0)}</td>
                      </tr>
                    </tbody>
                  </table>
                </td>
                <td style={{ borderRight: borderR }}></td>
              </tr>
            </>
          )}

          {/* ── EMPTY ROWS ── */}
          {emptyRowsCount > 0 && Array.from({ length: emptyRowsCount - 1 }).map((_, i) => (
            <tr key={`e-${i}`}>
              <td className={lineCell} style={{ height: '18px', borderLeft: borderL }}>&nbsp;</td>
              <td className={lineCell} colSpan={2} style={{ height: '18px' }}>&nbsp;</td>
              <td className={lineCell} style={{ height: '18px' }}>&nbsp;</td>
              <td className={lineCell} style={{ height: '18px' }}>&nbsp;</td>
              <td className={lineCell} style={{ height: '18px' }}>&nbsp;</td>
              <td className={lineCell} style={{ height: '18px' }}>&nbsp;</td>
              <td className={lineCell} style={{ height: '18px' }}>&nbsp;</td>
              <td className={lineCell} style={{ height: '18px', borderRight: borderR }}>&nbsp;</td>
            </tr>
          ))}
          {/* Last empty row stretches to fill remaining space */}
          {emptyRowsCount > 0 && (
            <tr key="e-last" style={{ height: '100%' }}>
              <td className={lineCell} style={{ borderLeft: borderL, borderBottom: borderB }}>&nbsp;</td>
              <td className={lineCell} colSpan={2} style={{ borderBottom: borderB }}>&nbsp;</td>
              <td className={lineCell} style={{ borderBottom: borderB }}>&nbsp;</td>
              <td className={lineCell} style={{ borderBottom: borderB }}>&nbsp;</td>
              <td className={lineCell} style={{ borderBottom: borderB }}>&nbsp;</td>
              <td className={lineCell} style={{ borderBottom: borderB }}>&nbsp;</td>
              <td className={lineCell} style={{ borderBottom: borderB }}>&nbsp;</td>
              <td className={lineCell} style={{ borderRight: borderR, borderBottom: borderB }}>&nbsp;</td>
            </tr>
          )}

          {/* ── TOTALS ROW ── */}
          <tr style={{ backgroundColor: '#e8e8e8' }}>
            <td className={`${totalCell} text-center font-bold`}>{fmtNum(totalQty)}</td>
            <td className={totalCell} colSpan={2}></td>
            <td className={totalCell}></td>
            <td className={totalCell}></td>
            <td className={totalCell}></td>
            <td className={`${totalCell} text-right font-bold`}>{fmtNum(totalCbm, 4)}</td>
            <td className={`${totalCell} text-right font-bold`}>{fmtNum(totalWeight)} KG</td>
            <td className={totalCell}></td>
          </tr>


        </tbody>
      </table>
    </div>
  )
})

WRDocument.displayName = 'WRDocument'
export default WRDocument
