import ExcelJS from 'exceljs'
import { AirBillingCharge } from '../types'

interface AwbRow {
  billing_unit_id: string
  awb_1st_leg: string | null
  awb_2nd_leg: string | null
  mawb_number: string | null
  cargo_type: string
  charges: AirBillingCharge[]
  total: number
}

interface FlightClientGroup {
  key: string
  flight_id: string
  client_id: string
  client_name: string
  airline: string
  flight_number: string
  charges: AirBillingCharge[]
  awbRows: AwbRow[]
  chargeNames: string[]
  total: number
  invoice: { invoice_number: string; status: string } | null
}

// Charge name mappings
const SCN_BUP_DROP_NAMES = ['BUILD UP + K9 SCREENING + DROP OFF']
const BREAKDOWN_NAMES = ['BREAKDOWN']
const PICKUP_PER_CW_NAMES = ['PICK UP']
const PICKUP_FLAT_NAMES = ['PICK UP - BUP']
const PALLET_NAMES = ['BUILD UP WOODEN PALLET']

function isSCN(name: string) { return SCN_BUP_DROP_NAMES.includes(name.toUpperCase()) || SCN_BUP_DROP_NAMES.includes(name) }
function isBreakdown(name: string) { return BREAKDOWN_NAMES.includes(name.toUpperCase()) || BREAKDOWN_NAMES.includes(name) }
function isPickupPerCw(name: string) { return PICKUP_PER_CW_NAMES.includes(name.toUpperCase()) || PICKUP_PER_CW_NAMES.includes(name) }
function isPickupFlat(name: string) { return PICKUP_FLAT_NAMES.includes(name.toUpperCase()) || PICKUP_FLAT_NAMES.includes(name) }
function isPallet(name: string) { return PALLET_NAMES.includes(name.toUpperCase()) || PALLET_NAMES.includes(name) }

interface ExcelRow {
  awb1st: string
  awb2nd: string
  cw: number
  scnRate: number | null
  pickup: number | null
  pickupIsFlat: boolean
  breakdown: number | null
  total: number
  type: string
}

export async function exportExpressLineExcel(g: FlightClientGroup) {
  const invoiceNum = g.invoice?.invoice_number?.replace(/^C0*/, '') || ''
  const airlineName = g.airline || g.flight_number || ''

  // Build rows and collect pallet totals
  const rows: ExcelRow[] = []
  let palletQtyTotal = 0
  let palletRate = 5

  for (const awb of g.awbRows) {
    let scnRate: number | null = null
    let pickupRate: number | null = null
    let pickupIsFlat = false
    let breakdownRate: number | null = null
    let cw = 0

    for (const ch of awb.charges) {
      const name = ch.charge_name || ''
      if (isSCN(name)) {
        scnRate = ch.rate
        cw = ch.chargeable_weight || ch.qty || 0
      } else if (isBreakdown(name)) {
        breakdownRate = ch.rate
        if (!cw) cw = ch.chargeable_weight || ch.qty || 0
      } else if (isPickupPerCw(name)) {
        pickupRate = ch.rate
        if (!cw) cw = ch.chargeable_weight || ch.qty || 0
      } else if (isPickupFlat(name)) {
        pickupRate = ch.total // flat amount (e.g. 50)
        pickupIsFlat = true
      } else if (isPallet(name)) {
        palletQtyTotal += ch.qty || 0
        palletRate = ch.rate || 5
      }
    }

    // Compute total excluding pallet
    let total = 0
    if (scnRate !== null) total += (scnRate * cw)
    if (pickupRate !== null) total += pickupIsFlat ? pickupRate : (pickupRate * cw)
    if (breakdownRate !== null) total += (breakdownRate * cw)

    rows.push({
      awb1st: awb.awb_1st_leg || (awb.mawb_number ? `MAWB ${awb.mawb_number}` : ''),
      awb2nd: awb.awb_2nd_leg || '',
      cw,
      scnRate,
      pickup: pickupRate,
      pickupIsFlat,
      breakdown: breakdownRate,
      total: Math.round(total * 100) / 100,
      type: (awb.cargo_type || '').toUpperCase() === 'BUP' ? 'BUP' : 'LOOSE',
    })
  }

  // Sort: BUP first, then LOOSE
  rows.sort((a, b) => {
    if (a.type === 'BUP' && b.type !== 'BUP') return -1
    if (a.type !== 'BUP' && b.type === 'BUP') return 1
    return 0
  })

  // Build Excel
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Invoice')

  // Column widths
  ws.columns = [
    { width: 16 },  // A: AIRLINE
    { width: 18 },  // B: 1st LEG AWB#
    { width: 18 },  // C: 2nd LEG AWB#
    { width: 12 },  // D: CW
    { width: 18 },  // E: SCN + BUP + DROP
    { width: 12 },  // F: PICKUP
    { width: 14 },  // G: BREAKDOWN
    { width: 14 },  // H: TOTAL
  ]

  const grayFill: ExcelJS.FillPattern = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } }
  const yellowFill: ExcelJS.FillPattern = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }
  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: 'thin' }, bottom: { style: 'thin' },
    left: { style: 'thin' }, right: { style: 'thin' },
  }
  const boldFont: Partial<ExcelJS.Font> = { bold: true, size: 10 }
  const normalFont: Partial<ExcelJS.Font> = { size: 10 }

  // Row 1: INVOICE# | number
  const r1 = ws.addRow(['INVOICE#', invoiceNum, '', '', '', '', '', ''])
  r1.getCell(1).font = boldFont
  r1.getCell(2).font = boldFont

  // Row 2: Headers (yellow background)
  const headers = ['AIRLINE', '1st LEG AWB#', '2nd LEG AWB#', 'CW', 'SCN + BUP + DROP', 'PICKUP', 'BREAKDOWN', 'TOTAL']
  const r2 = ws.addRow(headers)
  r2.eachCell((cell) => {
    cell.fill = yellowFill
    cell.font = { bold: true, size: 9 }
    cell.border = thinBorder
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
  })

  // Data rows
  const dataStartRow = 3
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const row = ws.addRow([
      i === 0 ? airlineName : '',  // AIRLINE only on first row
      r.awb1st,
      r.awb2nd,
      r.cw,
      r.scnRate,
      r.pickup,
      r.breakdown,
      r.total,
    ])

    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.fill = grayFill
      cell.font = normalFont
      cell.border = thinBorder
      if (col >= 4) cell.alignment = { horizontal: 'right' }
    })

    // Format numbers
    row.getCell(4).numFmt = '#,##0'        // CW
    if (r.scnRate !== null) row.getCell(5).numFmt = '0.00'
    if (r.pickup !== null) row.getCell(6).numFmt = r.pickupIsFlat ? '#,##0.00' : '0.00'
    if (r.breakdown !== null) row.getCell(7).numFmt = '0.00'
    row.getCell(8).numFmt = '$#,##0.00'    // TOTAL

    // Clear null cells
    if (r.scnRate === null) row.getCell(5).value = ''
    if (r.pickup === null) row.getCell(6).value = ''
    if (r.breakdown === null) row.getCell(7).value = ''

    // Type label in column I (no border, just text)
    const typeCell = ws.getCell(`I${dataStartRow + i}`)
    typeCell.value = r.type
    typeCell.font = normalFont
  }

  // Wooden Pallet row (if any)
  if (palletQtyTotal > 0) {
    const palletTotal = Math.round(palletQtyTotal * palletRate * 100) / 100
    const pRow = ws.addRow([
      '',
      'Wooden Pallet',
      '',
      palletQtyTotal,
      palletRate,
      '',
      '',
      palletTotal,
    ])
    pRow.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.fill = grayFill
      cell.font = normalFont
      cell.border = thinBorder
      if (col >= 4) cell.alignment = { horizontal: 'right' }
    })
    pRow.getCell(4).numFmt = '#,##0'
    pRow.getCell(5).numFmt = '0.00'
    pRow.getCell(8).numFmt = '$#,##0.00'
  }

  // TOTAL row
  const grandTotal = rows.reduce((s, r) => s + r.total, 0) + (palletQtyTotal > 0 ? palletQtyTotal * palletRate : 0)
  const tRow = ws.addRow(['', '', '', '', '', '', 'TOTAL:', Math.round(grandTotal * 100) / 100])
  tRow.getCell(7).font = boldFont
  tRow.getCell(7).fill = yellowFill
  tRow.getCell(7).border = thinBorder
  tRow.getCell(7).alignment = { horizontal: 'right' }
  tRow.getCell(8).font = boldFont
  tRow.getCell(8).fill = yellowFill
  tRow.getCell(8).border = thinBorder
  tRow.getCell(8).numFmt = '$#,##0.00'
  tRow.getCell(8).alignment = { horizontal: 'right' }

  // Merge AIRLINE cells vertically
  const lastDataRow = dataStartRow + rows.length - 1 + (palletQtyTotal > 0 ? 1 : 0)
  if (lastDataRow > dataStartRow) {
    ws.mergeCells(`A${dataStartRow}:A${lastDataRow}`)
    const mergedCell = ws.getCell(`A${dataStartRow}`)
    mergedCell.alignment = { vertical: 'middle', horizontal: 'center' }
    mergedCell.font = boldFont
  }

  // Download
  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `Invoice_${invoiceNum}_${g.client_name.replace(/\s+/g, '_')}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}
