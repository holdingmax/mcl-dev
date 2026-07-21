import ExcelJS from 'exceljs'
import { WarehouseReceipt, WRLine, SkuLine } from '../types'
import { formatWRDate } from './utils'

interface InventoryWR extends WarehouseReceipt {
  lines: WRLine[]
  skuLines?: SkuLine[]
}

const GREEN = '1A4D2E'
const NAVY  = '1E3A5F'
const GRAY  = 'E8E8E8'
const WHITE = 'FFFFFFFF'
const BLACK = 'FF000000'

function applyBorder(cell: ExcelJS.Cell) {
  const thin = { style: 'thin' as const, color: { argb: 'FFCCCCCC' } }
  cell.border = { top: thin, bottom: thin, left: thin, right: thin }
}

function styleHeader(cell: ExcelJS.Cell) {
  cell.font       = { bold: true, color: { argb: WHITE }, name: 'Arial', size: 9 }
  cell.fill       = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + GREEN } }
  cell.alignment  = { vertical: 'middle', horizontal: 'center' }
  applyBorder(cell)
}

function styleData(cell: ExcelJS.Cell, bold = false, bg?: string) {
  cell.font      = { bold, name: 'Arial', size: 9, color: { argb: BLACK } }
  cell.alignment = { vertical: 'middle' }
  if (bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bg } }
  applyBorder(cell)
}

function styleTotal(cell: ExcelJS.Cell) {
  cell.font  = { bold: true, name: 'Arial', size: 9, color: { argb: WHITE } }
  cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + NAVY } }
  cell.alignment = { vertical: 'middle' }
  applyBorder(cell)
}


export async function exportInventory(items: InventoryWR[], dateLabel: string) {
  const now      = new Date()
  const dateStr  = `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()}`
  const timeStr  = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`

  const wb = new ExcelJS.Workbook()
  wb.creator = 'MCL WMS'
  const ws = wb.addWorksheet('Inventario', { views: [{ showGridLines: false }] })

  const COLS = [
    { header: 'Cliente',        key: 'cliente',  width: 20 },
    { header: 'PO #',           key: 'po',       width: 14 },
    { header: 'WR #',           key: 'wr',       width: 16 },
    { header: 'Consignee',      key: 'cons',     width: 30 },
    { header: 'Shipper/Vendor', key: 'vendor',   width: 30 },
    { header: 'País Destino',   key: 'pais',     width: 10 },
    { header: 'Fecha Recepción',key: 'fecha',    width: 16 },
    { header: 'Línea',          key: 'linea',    width: 7  },
    { header: 'Tipo de Pieza',  key: 'tipo',     width: 13 },
    { header: 'LB',             key: 'lb',       width: 5  },
    { header: 'DG',             key: 'dg',       width: 5  },
    { header: 'QTY',            key: 'qty',      width: 6  },
    { header: 'Largo (cm)',     key: 'largo',    width: 10 },
    { header: 'Ancho (cm)',     key: 'ancho',    width: 10 },
    { header: 'Alto (cm)',      key: 'alto',     width: 10 },
    { header: 'CBM',            key: 'cbm',      width: 10 },
    { header: 'Peso KG',        key: 'peso',     width: 10 },
    { header: 'Ubicación',      key: 'ubic',     width: 14 },
    { header: 'Notas',          key: 'notas',    width: 20 },
    { header: 'SKU',             key: 'sku',      width: 18 },
    { header: 'VIN',             key: 'vin',      width: 18 },
    { header: 'Received Qty SKU',key: 'rqsku',    width: 16 },
    { header: 'Case Pack',       key: 'casepack', width: 12 },
  ]

  ws.columns = COLS.map(c => ({ key: c.key, width: c.width }))

  // ── Row 1: Title + Logo area ──────────────────────────────────────────────
  const titleRow = ws.addRow([])
  titleRow.height = 36
  const titleCell = titleRow.getCell(1)
  titleCell.value = 'REPORTE INVENTARIO MINCURLLOGISTICS - SEA FREIGHT'
  titleCell.font  = { bold: true, name: 'Arial', size: 13, color: { argb: 'FF' + GREEN } }
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' }
  ws.mergeCells(1, 1, 1, 16)

  // ── Row 2: Fecha ──────────────────────────────────────────────────────────
  const fechaRow = ws.addRow([])
  fechaRow.height = 16
  fechaRow.getCell(1).value = 'Fecha:'
  fechaRow.getCell(1).font  = { bold: true, name: 'Arial', size: 9 }
  fechaRow.getCell(2).value = dateStr
  fechaRow.getCell(2).font  = { name: 'Arial', size: 9 }

  // ── Row 3: Hora ───────────────────────────────────────────────────────────
  const horaRow = ws.addRow([])
  horaRow.height = 16
  horaRow.getCell(1).value = 'Hora:'
  horaRow.getCell(1).font  = { bold: true, name: 'Arial', size: 9 }
  horaRow.getCell(2).value = timeStr
  horaRow.getCell(2).font  = { name: 'Arial', size: 9 }

  // ── Row 4: Empty ──────────────────────────────────────────────────────────
  ws.addRow([]).height = 6

  // ── Row 5: Column headers ─────────────────────────────────────────────────
  const hdrRow = ws.addRow(COLS.map(c => c.header))
  hdrRow.height = 18
  hdrRow.eachCell(cell => styleHeader(cell))

  // ── Data rows ─────────────────────────────────────────────────────────────
  let grandQty = 0, grandCBM = 0, grandKG = 0

  for (const wr of items) {
    const dateWR    = wr.created_at ? formatWRDate(wr.created_at) : '—'
    const consignee = wr.consignee?.name || wr.consignee_name || '—'
    let   wrQty = 0, wrCBM = 0, wrKG = 0

    for (const line of wr.lines) {
      const qty = line.qty        ?? 0
      const cbm = line.cbm        ?? 0
      const kg  = line.weight_kg  ?? 0
      wrQty += qty; wrCBM += cbm; wrKG += kg

      const row = ws.addRow([
        wr.client_name || '—',
        wr.po_number, wr.wr_number, consignee, wr.company_name,
        wr.to_port, dateWR, line.line_order, line.packing_type,
        line.has_lb ? 'Sí' : 'No', line.is_dg ? 'Sí' : 'No',
        qty, line.length_cm ?? null, line.width_cm ?? null,
        line.height_cm ?? null, cbm, kg, line.location, line.remarks,
        '', '', '', '',
      ])
      row.height = 15
      row.eachCell((cell, col) => {
        styleData(cell)
        if ([12, 13, 14, 15, 16, 17].includes(col)) {
          cell.numFmt = '#,##0.00##'
          cell.alignment = { vertical: 'middle', horizontal: 'right' }
        }
      })
    }

    grandQty += wrQty; grandCBM += wrCBM; grandKG += wrKG

    // SKU detail rows
    if (wr.skuLines && wr.skuLines.length > 0) {
      for (const sk of wr.skuLines) {
        const skRow = ws.addRow([
          wr.client_name || '—',
          wr.po_number, wr.wr_number, consignee, wr.company_name,
          '', '', '', 'SKU Detail', '', '',
          '', '', '', '', '', '', '', '',
          sk.sku, sk.vin, sk.received_qty, sk.case_pack,
        ])
        skRow.height = 15
        skRow.eachCell((cell, col) => {
          styleData(cell, false, 'F5F5DC')
          if ([21, 22].includes(col)) {
            cell.numFmt = '#,##0'
            cell.alignment = { vertical: 'middle', horizontal: 'right' }
          }
        })
      }
    }

    // Subtotal row per WR
    const subRow = ws.addRow([
      wr.client_name || '—',
      `Subtotal ${wr.po_number}`, `Subtotal ${wr.wr_number}`,
      consignee, wr.company_name, '', '', '', '', '', '',
      wrQty, '', '', '', wrCBM, wrKG, '', '',
      '', '', '', '',
    ])
    subRow.height = 15
    subRow.eachCell((cell, col) => {
      styleData(cell, true, GRAY)
      if ([12, 16, 17].includes(col)) {
        cell.numFmt = '#,##0.00##'
        cell.alignment = { vertical: 'middle', horizontal: 'right' }
      }
    })
  }

  // ── TOTAL GENERAL ─────────────────────────────────────────────────────────
  const totalRow = ws.addRow([
    'TOTAL GENERAL', '', '', '', '', '', '', '', '', '', '',
    grandQty, '', '', '', grandCBM, grandKG, '', '',
    '', '', '', '',
  ])
  totalRow.height = 18
  totalRow.eachCell((cell, col) => {
    styleTotal(cell)
    if ([12, 16, 17].includes(col)) {
      cell.numFmt = '#,##0.00##'
      cell.alignment = { vertical: 'middle', horizontal: 'right' }
    }
  })

  // ── Download ──────────────────────────────────────────────────────────────
  const buffer   = await wb.xlsx.writeBuffer()
  const blob     = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url      = URL.createObjectURL(blob)
  const a        = document.createElement('a')
  a.href         = url
  a.download     = `Inventario_MCL_${dateLabel}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}
