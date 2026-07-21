const ExcelJS = require('exceljs')
const path = require('path')

async function main() {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Planning Diario')

  // Column widths
  ws.columns = [
    { width: 16 },  // A - Cliente
    { width: 14 },  // B - Aerolinea
    { width: 12 },  // C - Vuelo
    { width: 10 },  // D - Destino
    { width: 18 },  // E - REF AWB
    { width: 12 },  // F - Kilos
    { width: 12 },  // G - Estimado BUP
    { width: 16 },  // H - Hora Prod Bodega
    { width: 16 },  // I - K9
    { width: 18 },  // J - Hora Docs Ready
    { width: 14 },  // K - Hora Transporte
    { width: 14 },  // L - Cut Off
    { width: 18 },  // M - ETD
  ]

  // Styles
  const titleFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5233' } }
  const titleFont = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } }
  const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6C8' } }
  const headerFont = { bold: true, size: 10, color: { argb: 'FF000000' } }
  const kilosFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCCE5FF' } }
  const cutoffFont = { bold: true, size: 10, color: { argb: 'FFCC0000' } }
  const etdFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } }
  const cutoffFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFCC' } }
  const thinBorder = {
    top: { style: 'thin' }, bottom: { style: 'thin' },
    left: { style: 'thin' }, right: { style: 'thin' },
  }
  const centerAlign = { horizontal: 'center', vertical: 'middle', wrapText: true }
  const leftAlign = { horizontal: 'left', vertical: 'middle', wrapText: true }

  // Row 1: Title bar
  ws.mergeCells('A1:M1')
  const titleCell = ws.getCell('A1')
  titleCell.value = 'Planificacion Operacion Diaria'
  titleCell.fill = titleFill
  titleCell.font = titleFont
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(1).height = 30

  // Row 2: blank
  // Row 3: Fecha
  ws.getCell('A3').value = 'Fecha'
  ws.getCell('A3').font = { size: 10 }
  ws.getCell('B3').value = '05-30-26'
  ws.getCell('B3').font = { size: 10 }

  // Row 4: Preparado por
  ws.getCell('A4').value = 'Preparado por:'
  ws.getCell('A4').font = { size: 10 }
  ws.getCell('B4').value = 'Erick Durand'
  ws.getCell('B4').font = { bold: true, size: 10 }

  // Row 6: Headers
  const headers = [
    'Cliente', 'Aerolinea', 'Vuelo', 'Destino', 'REF AWB', 'Kilos',
    'Estimado\nBUP', 'Hora Prod\nBodega', 'K9', 'Hora Docs\nReady - Full\nSET',
    'Hora\nTransporte', 'Cut Off', 'ETD'
  ]
  const headerRow = ws.getRow(6)
  headerRow.height = 40
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = h
    cell.fill = headerFill
    cell.font = headerFont
    cell.alignment = centerAlign
    cell.border = thinBorder
  })

  // Data rows
  const dataRows = [
    // Row 7: MERFLEX
    {
      values: ['MERFLEX', 'AVIANCA', 'QT-4017', 'BOG', '729-93779276', 50131, 30, '0900-17:00', '12:00 - 15:00', '1330L', 'COT', '22:00 -\n30 MAY', '08:00 - 31MAY'],
      height: 40,
    },
    // Row 8: EXPRESS LINE - LA-0543
    {
      values: ['EXPRESS LINE', 'LATAM', 'LA-0543', 'EZE', '045-22209423', 5525, 4, '17:00-18:00', '', '1530L', 'COT', '22:00 -\n30 MAY', '23:00 - 31MAY'],
      height: 35,
    },
    // Row 9: continuation (K9 for LA-0543)
    {
      values: ['', '', '', '', '', '', '', '18:00 - 19:00', '', '', '', '', ''],
      height: 25,
    },
    // Row 10: EXPRESS LINE - QT-4093
    {
      values: ['EXPRESS LINE', 'AVIANCA', 'QT-4093', 'MVD', '729-93889714', 2298, 2, '18:00-19:00', '', '1930L', 'COT', '22:00 -\n30 MAY', '02:30 - 01 JUN'],
      height: 40,
    },
    // Row 11: EXPRESS LINE - UC-1527 (merged note)
    {
      values: ['EXPRESS LINE', 'LATAM', 'UC-1527', 'EZE', '045-20347902', 16957, 10, '', '', '', '', '01 JUN -\n10:00 AM', '16:20 - 01 JUN'],
      height: 40,
      mergeNote: true,
    },
    // Row 12: TOTAL
    {
      values: ['', '', '', 'TOTAL', '', 74911, 46, '', '', '', '', '', ''],
      height: 25,
      isTotal: true,
    },
  ]

  let rowIdx = 7
  for (const dr of dataRows) {
    const row = ws.getRow(rowIdx)
    row.height = dr.height
    dr.values.forEach((v, i) => {
      const cell = row.getCell(i + 1)
      cell.value = v
      cell.font = { size: 10 }
      cell.alignment = centerAlign
      cell.border = thinBorder

      // Kilos column highlight
      if (i === 5 && v) {
        cell.fill = kilosFill
        cell.font = { size: 10, bold: true }
        if (typeof v === 'number') cell.numFmt = '#,##0'
      }
      // Estimado BUP column highlight
      if (i === 6 && v) {
        cell.fill = kilosFill
        cell.font = { size: 10, bold: true }
      }
      // Cut Off column
      if (i === 11 && v) {
        cell.fill = cutoffFill
        cell.font = cutoffFont
      }
      // ETD column
      if (i === 12 && v) {
        cell.fill = etdFill
        cell.font = { size: 10, bold: true }
      }
      // Cliente, Aerolinea left align
      if (i <= 1) cell.alignment = { ...centerAlign, horizontal: 'center' }
    })

    // Total row styling
    if (dr.isTotal) {
      row.getCell(4).font = { size: 10, bold: true }
      row.getCell(4).alignment = { horizontal: 'right', vertical: 'middle' }
    }

    // Merged note for UC-1527
    if (dr.mergeNote) {
      ws.mergeCells(`H${rowIdx}:K${rowIdx}`)
      const noteCell = ws.getCell(`H${rowIdx}`)
      noteCell.value = 'Entre sabado y domingo se armara este vuelo'
      noteCell.alignment = centerAlign
      noteCell.font = { size: 10, italic: true }
      noteCell.border = thinBorder
      // Re-apply borders to merged range
      for (const col of ['I', 'J', 'K']) {
        ws.getCell(`${col}${rowIdx}`).border = thinBorder
      }
    }

    rowIdx++
  }

  // Save
  const outPath = path.join(__dirname, '..', 'prototypes', 'planning-operacion-diaria.xlsx')
  await wb.xlsx.writeFile(outPath)
  console.log('Excel saved to: ' + outPath)
}

main().catch(console.error)
