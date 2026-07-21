import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { doc, updateDoc, getDoc, collection, query, where, getDocs } from 'firebase/firestore'
import { storage, db } from './firebase'
import { storagePathFlight, fmtNum } from './utils'
import { AirfreightDocumentFile } from '../types'

// Match piece to AWB: handles both old data (piece has 1st leg) and new data (piece has 2nd leg)
function pieceMatchesAwb(p: PdfPiece, a: PdfAwb): boolean {
  return p.awb_number === a.awb_number || (!!a.awb_2nd_leg && p.awb_number === a.awb_2nd_leg)
}
function findAwbForPiece(piece: PdfPiece, awbs: PdfAwb[]): PdfAwb | undefined {
  return awbs.find(a => pieceMatchesAwb(piece, a))
}

// ── Types ────────────────────────────────────────────────────────────────

interface PdfFlight {
  id: string
  flight_number?: string
  airline?: string
  flight_datetime: string
  destinations?: string[]
}

interface PdfAwb {
  awb_number: string
  awb_2nd_leg: string | null
  mawb_number: string | null
  client_name: string
  agent_name?: string | null
  destination: string
  pieces_declared: number
  chargeable_weight: number
}

interface PdfPiece {
  awb_number: string
  weight_kg: number
  packing_type: string
  uld_id: string | null
  comment?: string
}

interface PdfUld {
  id: string
  uld_number: string
  conf: string
  type: string
  destination: string
}

// ── Helpers ──────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  try {
    const [datePart] = iso.split('T')
    const [y, m, d] = datePart.split('-')
    return `${m}/${d}/${y}`
  } catch { return iso }
}

function nowLabel() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

const MCL_DARK: [number, number, number] = [15, 23, 42]   // #0f172a
const MCL_BLUE: [number, number, number] = [30, 64, 175]   // #1e40af
const PURPLE: [number, number, number] = [124, 58, 237]    // #7c3aed
const WHITE: [number, number, number] = [255, 255, 255]

// ── Distribution PDF (AWB-first) ─────────────────────────────────────────

export function generateDistributionPdf(
  flight: PdfFlight,
  awbs: PdfAwb[],
  pieces: PdfPiece[],
  ulds: PdfUld[],
  userEmail: string,
): Blob {
  const d = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' })

  // Header
  d.setFillColor(...MCL_DARK)
  d.rect(12, 10, 10, 10, 'F')
  d.setTextColor(...WHITE)
  d.setFontSize(6)
  d.setFont('helvetica', 'bold')
  d.text('MCL', 14, 16.5)

  d.setTextColor(...MCL_DARK)
  d.setFontSize(14)
  d.text('DISTRIBUTION REPORT', 26, 15)
  d.setFontSize(7)
  d.setTextColor(150, 150, 150)
  d.text('Airwaybill from ULD', 26, 19)

  d.setFontSize(7)
  d.text(`Generated: ${nowLabel()}`, 200, 13, { align: 'right' })
  d.text(`Prepared by: ${userEmail}`, 200, 17, { align: 'right' })

  // Flight info bar
  const totalPcs = pieces.filter(p => p.uld_id).length
  const totalGross = pieces.filter(p => p.uld_id).reduce((s, p) => s + p.weight_kg, 0)
  const totalChw = awbs.reduce((s, a) => {
    const assignedRatio = a.pieces_declared > 0
      ? pieces.filter(p => pieceMatchesAwb(p, a) && p.uld_id).length / a.pieces_declared
      : 0
    return s + (a.chargeable_weight * assignedRatio)
  }, 0)

  d.setFillColor(248, 248, 248)
  d.roundedRect(12, 24, 188, 14, 2, 2, 'F')
  d.setDrawColor(220, 220, 220)
  d.roundedRect(12, 24, 188, 14, 2, 2, 'S')

  const infoItems = [
    ['CARRIER', flight.airline || '-'],
    ['FLIGHT', flight.flight_number || '-'],
    ['DATE', fmtDate(flight.flight_datetime)],
    ['DEST', (flight.destinations || []).join(', ') || '-'],
    ['PIECES', String(totalPcs)],
    ['GROSS', `${fmtNum(totalGross)} kg`],
    ['CHW', `${fmtNum(totalChw)} kg`],
  ]
  let ix = 16
  d.setFontSize(6)
  for (const [label, value] of infoItems) {
    d.setTextColor(150, 150, 150)
    d.text(label, ix, 29)
    d.setTextColor(40, 40, 40)
    d.setFont('helvetica', 'bold')
    d.setFontSize(7)
    d.text(value, ix, 34)
    d.setFont('helvetica', 'normal')
    d.setFontSize(6)
    ix += label === 'CARRIER' ? 32 : label === 'FLIGHT' ? 22 : label === 'DATE' ? 22 : label === 'DEST' ? 32 : 22
  }

  // Build table data
  const tableBody: any[] = []

  // Group AWBs: direct (no MAWB) first, then by MAWB
  const directAwbs = awbs.filter(a => !a.mawb_number)
  const mawbGroups = new Map<string, PdfAwb[]>()
  for (const a of awbs.filter(a => a.mawb_number)) {
    const key = a.mawb_number!
    if (!mawbGroups.has(key)) mawbGroups.set(key, [])
    mawbGroups.get(key)!.push(a)
  }

  function addAwbRows(awb: PdfAwb, indent = false) {
    const awbLabel = awb.awb_2nd_leg || awb.awb_number
    const awbPieces = pieces.filter(p => pieceMatchesAwb(p, awb) && p.uld_id)

    // AWB header row
    tableBody.push([{
      content: `${indent ? '    ' : ''}${awbLabel}  ${awb.agent_name || awb.client_name}`,
      colSpan: 8,
      styles: {
        fontStyle: 'bold',
        fillColor: [248, 248, 248],
        textColor: MCL_DARK,
        cellPadding: { top: 2, bottom: 2, left: 3, right: 3 },
      },
    }])

    // Group pieces by ULD
    const byUld = new Map<string, PdfPiece[]>()
    for (const p of awbPieces) {
      if (!byUld.has(p.uld_id!)) byUld.set(p.uld_id!, [])
      byUld.get(p.uld_id!)!.push(p)
    }

    let awbTotalPcs = 0
    let awbTotalGross = 0

    for (const [uldId, uldPieces] of byUld) {
      const uld = ulds.find(u => u.id === uldId)
      const pcs = uldPieces.length
      const gross = uldPieces.reduce((s, p) => s + p.weight_kg, 0)
      const chwRatio = awb.pieces_declared > 0 ? pcs / awb.pieces_declared : 0
      const chw = awb.chargeable_weight * chwRatio
      const comment = uldPieces[0]?.comment || ''
      awbTotalPcs += pcs
      awbTotalGross += gross

      tableBody.push([
        '', // AWB col empty
        awb.destination,
        uld ? `${uld.type}${uld.uld_number}` : uldId,
        { content: String(pcs), styles: { halign: 'right' as const } },
        { content: fmtNum(gross), styles: { halign: 'right' as const } },
        { content: fmtNum(chw), styles: { halign: 'right' as const, textColor: MCL_BLUE } },
        { content: '-', styles: { halign: 'right' as const, textColor: [150, 150, 150] } },
        comment,
      ])
    }

    // AWB total
    const awbChw = awb.pieces_declared > 0 ? awb.chargeable_weight * (awbTotalPcs / awb.pieces_declared) : 0
    tableBody.push([
      { content: `${indent ? '    ' : ''}AWB Total`, colSpan: 3, styles: { fontStyle: 'bold' as const, fillColor: [243, 243, 243] } },
      { content: String(awbTotalPcs), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: [243, 243, 243] } },
      { content: fmtNum(awbTotalGross), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: [243, 243, 243] } },
      { content: fmtNum(awbChw), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: [243, 243, 243], textColor: MCL_BLUE } },
      { content: '', colSpan: 2, styles: { fillColor: [243, 243, 243] } },
    ])
  }

  // Direct AWBs
  for (const awb of directAwbs) {
    addAwbRows(awb)
  }

  // MAWB groups
  for (const [mawb, mawbAwbs] of mawbGroups) {
    // MAWB header
    tableBody.push([{
      content: `MAWB  ${mawb}`,
      colSpan: 8,
      styles: {
        fontStyle: 'bold',
        fillColor: [245, 243, 255],
        textColor: PURPLE,
        cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 },
      },
    }])

    let mawbTotalPcs = 0
    let mawbTotalGross = 0
    let mawbTotalChw = 0

    for (const awb of mawbAwbs) {
      addAwbRows(awb, true)
      const awbPieces = pieces.filter(p => pieceMatchesAwb(p, awb) && p.uld_id)
      const pcs = awbPieces.length
      const gross = awbPieces.reduce((s, p) => s + p.weight_kg, 0)
      const chw = awb.pieces_declared > 0 ? awb.chargeable_weight * (pcs / awb.pieces_declared) : 0
      mawbTotalPcs += pcs
      mawbTotalGross += gross
      mawbTotalChw += chw
    }

    // MAWB subtotal
    tableBody.push([
      { content: `MAWB ${mawb} Total`, colSpan: 3, styles: { fontStyle: 'bold' as const, fillColor: [245, 243, 255], textColor: PURPLE } },
      { content: String(mawbTotalPcs), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: [245, 243, 255], textColor: PURPLE } },
      { content: fmtNum(mawbTotalGross), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: [245, 243, 255], textColor: PURPLE } },
      { content: fmtNum(mawbTotalChw), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: [245, 243, 255], textColor: PURPLE } },
      { content: '', colSpan: 2, styles: { fillColor: [245, 243, 255] } },
    ])
  }

  // Grand total
  const grandPcs = pieces.filter(p => p.uld_id).length
  const grandGross = pieces.filter(p => p.uld_id).reduce((s, p) => s + p.weight_kg, 0)
  const uldCount = ulds.filter(u => pieces.some(p => p.uld_id === u.id)).length
  const awbCount = awbs.filter(a => pieces.some(p => pieceMatchesAwb(p, a) && p.uld_id)).length
  const mawbCount = mawbGroups.size

  const grandLabel = `GRAND TOTAL — ${uldCount} ULD${uldCount !== 1 ? 's' : ''} / ${awbCount} AWB${awbCount !== 1 ? 's' : ''}${mawbCount > 0 ? ` / ${mawbCount} MAWB` : ''}`
  tableBody.push([
    { content: grandLabel, colSpan: 3, styles: { fontStyle: 'bold' as const, fillColor: MCL_DARK, textColor: WHITE } },
    { content: String(grandPcs), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: MCL_DARK, textColor: WHITE } },
    { content: fmtNum(grandGross), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: MCL_DARK, textColor: WHITE } },
    { content: fmtNum(totalChw), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: MCL_DARK, textColor: [147, 197, 253] } },
    { content: '', colSpan: 2, styles: { fillColor: MCL_DARK } },
  ])

  autoTable(d, {
    startY: 42,
    margin: { left: 12, right: 12 },
    head: [['AIRWAYBILL', 'DEST', 'PALLET NO.', 'PIECES', 'GROSS (KG)', 'CHW (KG)', 'VOL (M3)', 'COMMENTS']],
    body: tableBody,
    headStyles: {
      fillColor: MCL_DARK,
      textColor: WHITE,
      fontStyle: 'bold',
      fontSize: 7,
      cellPadding: 2,
    },
    styles: {
      fontSize: 7,
      cellPadding: 1.5,
      overflow: 'linebreak',
    },
    columnStyles: {
      0: { cellWidth: 32 },
      1: { cellWidth: 14 },
      2: { cellWidth: 28 },
      3: { cellWidth: 16, halign: 'right' },
      4: { cellWidth: 22, halign: 'right' },
      5: { cellWidth: 22, halign: 'right' },
      6: { cellWidth: 18, halign: 'right' },
      7: { cellWidth: 'auto' },
    },
    theme: 'grid',
    tableLineColor: [220, 220, 220],
    tableLineWidth: 0.1,
  })

  return d.output('blob')
}

// ── Pallet Control PDF (ULD-first) ───────────────────────────────────────

export function generatePalletControlPdf(
  flight: PdfFlight,
  awbs: PdfAwb[],
  pieces: PdfPiece[],
  ulds: PdfUld[],
  userEmail: string,
): Blob {
  const d = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' })

  // Header
  d.setFillColor(...MCL_DARK)
  d.rect(12, 10, 10, 10, 'F')
  d.setTextColor(...WHITE)
  d.setFontSize(6)
  d.setFont('helvetica', 'bold')
  d.text('MCL', 14, 16.5)

  d.setTextColor(...MCL_DARK)
  d.setFontSize(14)
  d.text('PALLET CONTROL', 26, 15)
  d.setFontSize(7)
  d.setTextColor(150, 150, 150)
  d.text('ULD Distribution Detail', 26, 19)

  d.setFontSize(7)
  d.text(`Generated: ${nowLabel()}`, 200, 13, { align: 'right' })
  d.text(`Prepared by: ${userEmail}`, 200, 17, { align: 'right' })

  // Flight info bar
  const totalPcs = pieces.filter(p => p.uld_id).length
  const totalGross = pieces.filter(p => p.uld_id).reduce((s, p) => s + p.weight_kg, 0)
  const totalChw = awbs.reduce((s, a) => {
    const assignedRatio = a.pieces_declared > 0
      ? pieces.filter(p => pieceMatchesAwb(p, a) && p.uld_id).length / a.pieces_declared
      : 0
    return s + (a.chargeable_weight * assignedRatio)
  }, 0)

  d.setFillColor(248, 248, 248)
  d.roundedRect(12, 24, 188, 14, 2, 2, 'F')
  d.setDrawColor(220, 220, 220)
  d.roundedRect(12, 24, 188, 14, 2, 2, 'S')

  const infoItems = [
    ['CARRIER', flight.airline || '-'],
    ['FLIGHT', flight.flight_number || '-'],
    ['DATE', fmtDate(flight.flight_datetime)],
    ['DEST', (flight.destinations || []).join(', ') || '-'],
    ['PIECES', String(totalPcs)],
    ['GROSS', `${fmtNum(totalGross)} kg`],
    ['CHW', `${fmtNum(totalChw)} kg`],
  ]
  let ix = 16
  d.setFontSize(6)
  for (const [label, value] of infoItems) {
    d.setTextColor(150, 150, 150)
    d.text(label, ix, 29)
    d.setTextColor(40, 40, 40)
    d.setFont('helvetica', 'bold')
    d.setFontSize(7)
    d.text(value, ix, 34)
    d.setFont('helvetica', 'normal')
    d.setFontSize(6)
    ix += label === 'CARRIER' ? 32 : label === 'FLIGHT' ? 22 : label === 'DATE' ? 22 : label === 'DEST' ? 32 : 22
  }

  // Build table data
  const tableBody: any[] = []

  // ULDs with assigned pieces
  const activeUlds = ulds.filter(u => pieces.some(p => p.uld_id === u.id))

  // Track MAWB totals across all ULDs
  const mawbGrandTotals = new Map<string, { pcs: number; gross: number; chw: number }>()

  for (const uld of activeUlds) {
    const uldPieces = pieces.filter(p => p.uld_id === uld.id)

    // ULD header
    tableBody.push([{
      content: `${uld.type}${uld.uld_number}`,
      colSpan: 7,
      styles: {
        fontStyle: 'bold',
        fontSize: 8,
        fillColor: [240, 242, 245],
        textColor: MCL_DARK,
        cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 },
      },
    }])

    // Group by AWB
    const awbMap = new Map<string, PdfPiece[]>()
    for (const p of uldPieces) {
      if (!awbMap.has(p.awb_number)) awbMap.set(p.awb_number, [])
      awbMap.get(p.awb_number)!.push(p)
    }

    let uldTotalPcs = 0
    let uldTotalGross = 0
    let uldTotalChw = 0

    // Track MAWB subtotals within this ULD
    const uldMawbTotals = new Map<string, { pcs: number; gross: number; chw: number }>()

    for (const [awbNum, awbPieces] of awbMap) {
      const awb = awbs.find(a => a.awb_number === awbNum || (a.awb_2nd_leg && a.awb_2nd_leg === awbNum))
      const pcs = awbPieces.length
      const gross = awbPieces.reduce((s, p) => s + p.weight_kg, 0)
      const chwRatio = awb && awb.pieces_declared > 0 ? pcs / awb.pieces_declared : 0
      const chw = awb ? awb.chargeable_weight * chwRatio : 0
      const comment = awbPieces[0]?.comment || ''
      const awbLabel = awb?.awb_2nd_leg || awbNum

      uldTotalPcs += pcs
      uldTotalGross += gross
      uldTotalChw += chw

      // Track MAWB
      if (awb?.mawb_number) {
        const m = awb.mawb_number
        if (!uldMawbTotals.has(m)) uldMawbTotals.set(m, { pcs: 0, gross: 0, chw: 0 })
        const mt = uldMawbTotals.get(m)!
        mt.pcs += pcs; mt.gross += gross; mt.chw += chw
        if (!mawbGrandTotals.has(m)) mawbGrandTotals.set(m, { pcs: 0, gross: 0, chw: 0 })
        const gt = mawbGrandTotals.get(m)!
        gt.pcs += pcs; gt.gross += gross; gt.chw += chw
      }

      tableBody.push([
        awbLabel,
        awb?.destination || '',
        { content: String(pcs), styles: { halign: 'right' as const } },
        { content: fmtNum(gross), styles: { halign: 'right' as const } },
        { content: fmtNum(chw), styles: { halign: 'right' as const, textColor: MCL_BLUE } },
        { content: '-', styles: { halign: 'right' as const, textColor: [150, 150, 150] } },
        comment,
      ])
    }

    // MAWB subtotals within this ULD
    for (const [mawb, mt] of uldMawbTotals) {
      tableBody.push([
        { content: `MAWB ${mawb}`, colSpan: 2, styles: { fontStyle: 'bold' as const, fillColor: [245, 243, 255], textColor: PURPLE, fontSize: 6.5 } },
        { content: String(mt.pcs), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: [245, 243, 255], textColor: PURPLE } },
        { content: fmtNum(mt.gross), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: [245, 243, 255], textColor: PURPLE } },
        { content: fmtNum(mt.chw), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: [245, 243, 255], textColor: PURPLE } },
        { content: '', colSpan: 2, styles: { fillColor: [245, 243, 255] } },
      ])
    }

    // ULD total
    tableBody.push([
      { content: 'ULD Total', colSpan: 2, styles: { fontStyle: 'bold' as const, fillColor: [243, 243, 243] } },
      { content: String(uldTotalPcs), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: [243, 243, 243] } },
      { content: fmtNum(uldTotalGross), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: [243, 243, 243] } },
      { content: fmtNum(uldTotalChw), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: [243, 243, 243], textColor: MCL_BLUE } },
      { content: '', colSpan: 2, styles: { fillColor: [243, 243, 243] } },
    ])
  }

  // MAWB grand totals (across all ULDs)
  for (const [mawb, gt] of mawbGrandTotals) {
    tableBody.push([
      { content: `MAWB ${mawb} Grand Total`, colSpan: 2, styles: { fontStyle: 'bold' as const, fillColor: [233, 228, 255], textColor: PURPLE } },
      { content: String(gt.pcs), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: [233, 228, 255], textColor: PURPLE } },
      { content: fmtNum(gt.gross), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: [233, 228, 255], textColor: PURPLE } },
      { content: fmtNum(gt.chw), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: [233, 228, 255], textColor: PURPLE } },
      { content: '', colSpan: 2, styles: { fillColor: [233, 228, 255] } },
    ])
  }

  // Grand total
  const uldCount = activeUlds.length
  const awbCount = new Set(pieces.filter(p => p.uld_id).map(p => p.awb_number)).size
  const mawbCount = mawbGrandTotals.size
  const grandLabel = `GRAND TOTAL — ${uldCount} ULD${uldCount !== 1 ? 's' : ''} / ${awbCount} AWB${awbCount !== 1 ? 's' : ''}${mawbCount > 0 ? ` / ${mawbCount} MAWB` : ''}`

  tableBody.push([
    { content: grandLabel, colSpan: 2, styles: { fontStyle: 'bold' as const, fillColor: MCL_DARK, textColor: WHITE } },
    { content: String(totalPcs), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: MCL_DARK, textColor: WHITE } },
    { content: fmtNum(totalGross), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: MCL_DARK, textColor: WHITE } },
    { content: fmtNum(totalChw), styles: { halign: 'right' as const, fontStyle: 'bold' as const, fillColor: MCL_DARK, textColor: [147, 197, 253] } },
    { content: '', colSpan: 2, styles: { fillColor: MCL_DARK } },
  ])

  autoTable(d, {
    startY: 42,
    margin: { left: 12, right: 12 },
    head: [['AIRWAYBILL', 'DEST', 'PIECES', 'GROSS (KG)', 'CHW (KG)', 'VOL (M3)', 'COMMENTS']],
    body: tableBody,
    headStyles: {
      fillColor: MCL_DARK,
      textColor: WHITE,
      fontStyle: 'bold',
      fontSize: 7,
      cellPadding: 2,
    },
    styles: {
      fontSize: 7,
      cellPadding: 1.5,
      overflow: 'linebreak',
    },
    columnStyles: {
      0: { cellWidth: 36 },
      1: { cellWidth: 14 },
      2: { cellWidth: 16, halign: 'right' },
      3: { cellWidth: 22, halign: 'right' },
      4: { cellWidth: 22, halign: 'right' },
      5: { cellWidth: 18, halign: 'right' },
      6: { cellWidth: 'auto' },
    },
    theme: 'grid',
    tableLineColor: [220, 220, 220],
    tableLineWidth: 0.1,
  })

  return d.output('blob')
}

// ── Pallet Tag PDF ──────────────────────────────────────────────────────

interface PalletTagData {
  airlineCode: string
  airlineName: string
  uldNumber: string
  destination: string
  position: string  // MD / LD / ESP
  netWeightKg: number
  tareWeightKg: number
  loadedAt: string
  flightNumber: string
  flightDate: string  // ISO
  specialHandling?: string
  noteLines: string[]  // AWB or MAWB lines like "045-21859596 (14 pcs) - eli"
  userEmail: string
}

async function loadLogoBase64(): Promise<string | null> {
  try {
    const resp = await fetch(`${window.location.origin}/logo.png`)
    const buf = await resp.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  } catch { return null }
}

export async function generatePalletTagPdf(tags: PalletTagData[]): Promise<Blob> {
  const d = new jsPDF({ orientation: 'portrait', unit: 'mm', format: [110, 160] })
  const logo = await loadLogoBase64()
  const DARK: [number, number, number] = [30, 58, 95]
  const GRAY: [number, number, number] = [120, 120, 120]
  const LIGHT_BG: [number, number, number] = [245, 246, 248]

  for (let ti = 0; ti < tags.length; ti++) {
    if (ti > 0) d.addPage([110, 160])
    const t = tags[ti]
    const W = 110, M = 6
    const CW = W - M * 2
    let y = M

    // ── Header: airline code left, MCL logo right ──
    d.setFont('helvetica', 'bold')
    d.setFontSize(24)
    d.setTextColor(0)
    d.text(t.airlineCode, M + 2, y + 12)
    d.setFontSize(5.5)
    d.setTextColor(...GRAY)
    d.text(t.airlineName.toUpperCase(), M + 2, y + 16)

    if (logo) {
      d.addImage(`data:image/png;base64,${logo}`, 'PNG', W - M - 28, y + 1, 26, 16)
    } else {
      d.setFontSize(9)
      d.setTextColor(0)
      d.text('MINCURL', W - M - 25, y + 10)
    }
    d.setDrawColor(200, 200, 200)
    d.setLineWidth(0.2)
    d.line(M, y + 18, W - M, y + 18)
    y += 22

    // ── ULD Number (big, centered) ──
    d.setFont('helvetica', 'bold')
    d.setFontSize(26)
    d.setTextColor(0)
    d.text(t.uldNumber, W / 2, y + 8, { align: 'center' })
    y += 12
    // thin separator
    d.setDrawColor(200, 200, 200)
    d.setLineWidth(0.2)
    d.line(M, y, W - M, y)
    y += 3

    // ── Destination | Position ──
    d.setFontSize(5)
    d.setFont('helvetica', 'normal')
    d.setTextColor(...GRAY)
    d.text('DESTINATION', M + 2, y + 3)
    d.text('POSITION', M + CW * 0.6 + 4, y + 3)

    d.setFont('helvetica', 'bold')
    d.setTextColor(0)
    d.setFontSize(30)
    d.text(t.destination, M + 2, y + 15)
    d.setFontSize(22)
    d.text(t.position, M + CW * 0.6 + 4, y + 15)
    y += 19
    d.setDrawColor(200, 200, 200)
    d.line(M, y, W - M, y)
    y += 3

    // ── Weight section ──
    d.setDrawColor(200, 200, 200)
    d.setLineWidth(0.2)
    // vertical divider between left (net/tare) and right (total)
    d.line(M + CW * 0.5, y, M + CW * 0.5, y + 20)
    // horizontal divider between net and tare
    d.line(M, y + 10, M + CW * 0.5, y + 10)

    // Net (right side, prominent — most important)
    const totalKg = t.netWeightKg + t.tareWeightKg
    d.setFontSize(6)
    d.setFont('helvetica', 'normal')
    d.setTextColor(...GRAY)
    d.text('NET WEIGHT KG', M + CW * 0.55, y + 4)
    d.setFont('helvetica', 'bold')
    d.setFontSize(22)
    d.setTextColor(0)
    d.text(fmtNum(t.netWeightKg), M + CW * 0.55, y + 15)

    // Tare (top left)
    d.setFontSize(6)
    d.setFont('helvetica', 'normal')
    d.setTextColor(...GRAY)
    d.text('TARE WEIGHT KG', M + 3, y + 4)
    d.setFont('helvetica', 'bold')
    d.setFontSize(11)
    d.setTextColor(0)
    d.text(fmtNum(t.tareWeightKg), M + 3, y + 9.5)

    // Total (bottom left)
    d.setFontSize(6)
    d.setFont('helvetica', 'normal')
    d.setTextColor(...GRAY)
    d.text('TOTAL KG', M + 3, y + 14)
    d.setFont('helvetica', 'bold')
    d.setFontSize(11)
    d.setTextColor(0)
    d.text(fmtNum(totalKg), M + 3, y + 19.5)

    y += 23

    // ── Flight info row ──
    d.setFontSize(6)
    d.setFont('helvetica', 'normal')
    d.setTextColor(...GRAY)
    d.text('LOADED AT', M + 2, y + 3)
    d.text('FLIGHT', M + 20, y + 3)
    d.text('DATE', M + CW * 0.7, y + 3)

    d.setFont('helvetica', 'bold')
    d.setTextColor(0)
    d.setFontSize(10)
    d.text(t.loadedAt, M + 2, y + 9)
    d.setFontSize(15)
    d.text(t.flightNumber, M + 20, y + 9)
    d.setFontSize(8)
    d.text(fmtDate(t.flightDate), M + CW * 0.7, y + 9)
    y += 12
    d.setDrawColor(200, 200, 200)
    d.line(M, y, W - M, y)
    y += 3

    // ── Special Handling Code ──
    d.setFontSize(6)
    d.setFont('helvetica', 'normal')
    d.setTextColor(...GRAY)
    d.text('SPECIAL HANDLING CODE', M + 2, y + 3)
    if (t.specialHandling) {
      d.setFontSize(8)
      d.setTextColor(0)
      d.setFont('helvetica', 'bold')
      d.text(t.specialHandling, M + 2, y + 8)
    }
    y += 10

    // ── Note ──
    d.setFontSize(6)
    d.setFont('helvetica', 'normal')
    d.setTextColor(...GRAY)
    d.text('NOTE', M + 2, y + 3)
    d.setFontSize(7.5)
    d.setTextColor(0)
    d.setFont('helvetica', 'normal')
    for (let i = 0; i < t.noteLines.length; i++) {
      d.text(t.noteLines[i], M + 2, y + 8 + i * 4)
    }
    const noteUsed = Math.max(12, 8 + t.noteLines.length * 4)
    y += noteUsed + 1
    d.setDrawColor(200, 200, 200)
    d.line(M, y, W - M, y)
    y += 2

    // ── Barcode area ──
    const barcodeText = `${t.uldNumber}-${t.flightNumber.replace(/\s/g, '')}-${t.flightDate.split('T')[0].replace(/-/g, '')}`

    const bx = M + 8, bw = CW - 16, bh = 11
    d.setFillColor(0)
    for (let i = 0; i < bw; i += 2.5) {
      const w = (Math.sin(i * 1.7) > 0) ? 1.2 : 0.6
      d.rect(bx + i, y, w, bh, 'F')
    }
    y += bh + 1
    d.setFontSize(5)
    d.setTextColor(80)
    d.setFont('helvetica', 'normal')
    d.text(barcodeText, W / 2, y + 2, { align: 'center' })
    y += 6

    // ── Footer ──
    d.setFontSize(4.5)
    d.setTextColor(150)
    d.setFont('helvetica', 'normal')
    d.text(`Print Date: ${nowLabel()}`, M + 2, y + 2)
    d.setFont('helvetica', 'bold')
    d.setTextColor(100)
    d.text(t.userEmail.split('@')[0].toUpperCase(), W - M - 2, y + 2, { align: 'right' })
  }

  return d.output('blob')
}

// ── Upload Distribution PDF to Firebase ──────────────────────────────────

export async function uploadDistributionPdf(
  flight: PdfFlight,
  awbs: PdfAwb[],
  pieces: PdfPiece[],
  ulds: PdfUld[],
  userEmail: string,
): Promise<void> {
  // Don't generate if no ULDs or no assigned pieces
  if (ulds.length === 0 || !pieces.some(p => p.uld_id)) return

  const blob = generateDistributionPdf(flight, awbs, pieces, ulds, userEmail)
  const ts = Date.now()
  const filename = `doc_distribucion_${ts}.pdf`

  const path = storagePathFlight({
    flightNumber: flight.flight_number,
    flightDate: flight.flight_datetime,
    airline: flight.airline,
    filename,
  })

  const storageRef = ref(storage, path)
  await uploadBytes(storageRef, blob, { contentType: 'application/pdf' })
  const url = await getDownloadURL(storageRef)

  // Update flight document
  const flightRef = doc(db, 'airfreight_flights', flight.id)
  const snap = await getDoc(flightRef)
  const existing = snap.data()?.doc_distribucion as AirfreightDocumentFile | undefined

  const newFile: AirfreightDocumentFile = {
    url,
    filename,
    version: (existing?.version || 0) + 1,
    uploaded_at: new Date().toISOString(),
    uploaded_by: userEmail,
    modified_seen: true,
    history: existing ? [...(existing.history || []), { url: existing.url, filename: existing.filename, version: existing.version, uploaded_at: existing.uploaded_at, uploaded_by: existing.uploaded_by }] : [],
  }

  await updateDoc(flightRef, { doc_distribucion: newFile })
}

// ── Pallet Tag Document PDF (letter size, per-ULD manifest) ─────────────

export interface PalletTagDocData {
  uldNumber: string       // e.g. "AKE 51391 LA"
  flightNumber: string
  flightDate: string      // ISO
  destination: string
  position: string        // MD / LD / ESP
  totalWeightKg: number
  awbLines: { awb: string; pieces: number; weightKg: number; remark: string }[]
  noteLines: string[]
  userEmail: string
}

export function generatePalletTagDocPdf(docs: PalletTagDocData[]): Blob {
  const d = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' })
  const W = 215.9, H = 279.4, M = 15
  const CW = W - M * 2

  for (let di = 0; di < docs.length; di++) {
    if (di > 0) d.addPage('letter')
    const t = docs[di]
    let y = M

    // ── Header ──
    d.setFont('helvetica', 'bolditalic')
    d.setFontSize(18)
    d.setTextColor(0)
    d.text('MINCURL', M, y + 7)
    d.setFont('helvetica', 'normal')
    d.setFontSize(7)
    d.setTextColor(100)
    d.text('MIAMI, FLORIDA', M, y + 11)

    d.setFont('helvetica', 'bold')
    d.setFontSize(22)
    d.setTextColor(0)
    d.text('PALLET TAG', W - M, y + 7, { align: 'right' })
    d.setFont('helvetica', 'normal')
    d.setFontSize(7)
    d.setTextColor(100)
    d.text('CARGO TRANSFER DOCUMENT', W - M, y + 11, { align: 'right' })

    y += 14
    d.setDrawColor(0)
    d.setLineWidth(0.6)
    d.line(M, y, W - M, y)
    y += 4

    // ── Info grid ──
    const halfW = CW / 2
    const leftX = M, rightX = M + halfW

    // Left: Pallet / Flight / Date
    d.setDrawColor(0)
    d.setLineWidth(0.4)
    d.rect(leftX, y, halfW, 18)

    // Header row
    d.setFillColor(232, 232, 232)
    d.rect(leftX, y, halfW, 8, 'F')
    d.setDrawColor(0)
    d.line(leftX, y + 8, leftX + halfW, y + 8)

    const col1 = halfW * 0.4, col2 = halfW * 0.3
    d.line(leftX + col1, y, leftX + col1, y + 18)
    d.line(leftX + col1 + col2, y, leftX + col1 + col2, y + 18)

    d.setFont('helvetica', 'bold')
    d.setFontSize(7)
    d.setTextColor(0)
    d.text('PALLET No.', leftX + 2, y + 5)
    d.text('FLIGHT No.', leftX + col1 + 2, y + 5)
    d.text('DATE', leftX + col1 + col2 + 2, y + 5)

    // Format date
    const fd = new Date(t.flightDate)
    const dateStr = !isNaN(fd.getTime()) ? `${String(fd.getMonth()+1).padStart(2,'0')}/${String(fd.getDate()).padStart(2,'0')}/${fd.getFullYear()}` : ''

    d.setFont('courier', 'bold')
    d.setFontSize(10)
    d.text(t.uldNumber, leftX + 2, y + 14)
    d.text(t.flightNumber, leftX + col1 + 2, y + 14)
    d.text(dateStr, leftX + col1 + col2 + 2, y + 14)

    // Right: Position / Destination / Weight
    d.setDrawColor(0)
    d.rect(rightX, y, halfW, 18)

    // Position/Destination labels
    const posW = halfW * 0.4, destW = halfW * 0.6
    d.setFillColor(232, 232, 232)
    d.rect(rightX, y, halfW, 5, 'F')
    d.line(rightX, y + 5, rightX + halfW, y + 5)
    d.line(rightX + posW, y, rightX + posW, y + 18)

    d.setFont('helvetica', 'bold')
    d.setFontSize(7)
    d.setTextColor(0)
    d.text('POSITION', rightX + 2, y + 3.5)
    d.text('DESTINATION', rightX + posW + 2, y + 3.5)

    // Position value
    d.setFont('helvetica', 'bold')
    d.setFontSize(14)
    d.text(t.position, rightX + posW / 2, y + 12, { align: 'center' })

    // Destination value (large)
    d.setFontSize(32)
    d.text(t.destination, rightX + posW + destW / 2, y + 14.5, { align: 'center' })

    y += 20

    // Weight row
    const totalLbs = t.totalWeightKg * 2.20462
    d.setFont('helvetica', 'bold')
    d.setFontSize(7)
    d.setTextColor(100)
    d.text('TOTAL WEIGHT', W - M - 60, y + 4)
    d.setFont('courier', 'bold')
    d.setFontSize(16)
    d.setTextColor(0)
    d.text(`${fmtNum(t.totalWeightKg, 1)} Kgs`, W - M, y + 5, { align: 'right' })
    d.setFontSize(11)
    d.setTextColor(100)
    d.text(`${fmtNum(totalLbs, 1)} Lbs`, W - M, y + 10, { align: 'right' })
    y += 14

    // ── AWB Table ──
    const colWidths = [CW * 0.30, CW * 0.12, CW * 0.18, CW * 0.40]
    const headers = ['AIRWAYBILL No.', 'PIECES', 'WEIGHT (Kg)', 'REMARK']
    const rowH = 6.5

    // Header
    d.setFillColor(232, 232, 232)
    d.rect(M, y, CW, rowH, 'FD')
    d.setFont('helvetica', 'bold')
    d.setFontSize(7)
    d.setTextColor(0)
    let cx = M
    for (let i = 0; i < headers.length; i++) {
      d.text(headers[i], cx + 2, y + 4.5)
      if (i < headers.length - 1) d.line(cx + colWidths[i], y, cx + colWidths[i], y + rowH)
      cx += colWidths[i]
    }
    d.setLineWidth(0.4)
    d.line(M, y + rowH, W - M, y + rowH)
    y += rowH

    // Data rows
    const dataStartY = y
    d.setFont('courier', 'normal')
    d.setFontSize(9)
    d.setTextColor(0)
    for (const line of t.awbLines) {
      cx = M
      d.text(line.awb, cx + 2, y + 4.5)
      cx += colWidths[0]
      d.text(String(line.pieces), cx + 2, y + 4.5)
      cx += colWidths[1]
      d.text(fmtNum(line.weightKg), cx + 2, y + 4.5)
      cx += colWidths[2]
      d.setFont('helvetica', 'normal')
      d.setFontSize(8)
      const remark = line.remark.length > 40 ? line.remark.substring(0, 40) + '...' : line.remark
      d.text(remark, cx + 2, y + 4.5)
      d.setFont('courier', 'normal')
      d.setFontSize(9)
      d.line(M, y + rowH, W - M, y + rowH)
      y += rowH
    }

    // Empty rows — fill until ~2 rows before notes area
    const notesY = H - M - 50  // reserve space for notes + prepared by + footer
    const totalRowY = notesY - 20  // 2 gap rows (13mm) + total rows (7mm)
    while (y + rowH < totalRowY) {
      y += rowH
    }

    // Left + right borders for the data section
    d.setLineWidth(0.4)
    d.rect(M, dataStartY - rowH, CW, y - dataStartY + rowH)

    // Total row
    const totalPcs = t.awbLines.reduce((s, l) => s + l.pieces, 0)
    const totalKg = t.awbLines.reduce((s, l) => s + l.weightKg, 0)
    const totalLbs2 = totalKg * 2.20462

    d.setFillColor(232, 232, 232)
    d.rect(M, y, CW, rowH * 2, 'F')
    d.setDrawColor(0)
    d.setLineWidth(0.4)
    d.line(M, y, W - M, y)

    d.setFont('courier', 'bold')
    d.setFontSize(9)
    d.setTextColor(0)
    cx = M
    d.text('TOTAL', cx + 2, y + 4.5)
    cx += colWidths[0]
    d.text(String(totalPcs), cx + 2, y + 4.5)
    cx += colWidths[1]
    d.text(`${fmtNum(totalKg, 1)} Kgs`, cx + 2, y + 4.5)

    // Lbs line below
    d.setFontSize(8)
    d.setTextColor(80)
    d.text(`${fmtNum(totalLbs2, 1)} Lbs`, M + colWidths[0] + colWidths[1] + 2, y + 4.5 + rowH)

    // Close total box
    d.setDrawColor(0)
    d.rect(M, y, CW, rowH * 2)
    y += rowH * 2

    // ── 2 rows gap ──
    y += rowH * 2

    // ── Notes ──
    const notesBoxH = Math.max(16, t.noteLines.length * 4 + 10)
    d.setDrawColor(0)
    d.setLineWidth(0.4)
    d.rect(M, y, CW, notesBoxH)

    d.setFillColor(232, 232, 232)
    d.rect(M, y, CW, 6, 'F')
    d.line(M, y + 6, W - M, y + 6)
    d.setFont('helvetica', 'bold')
    d.setFontSize(7)
    d.setTextColor(0)
    d.text('NOTES', M + 2, y + 4)

    d.setFont('courier', 'normal')
    d.setFontSize(8)
    let ny = y + 10
    for (const note of t.noteLines) {
      d.text(note, M + 2, ny)
      ny += 4
    }
    y += notesBoxH + 3

    // ── Prepared By ──
    d.setDrawColor(0)
    d.rect(M, y, CW * 0.5, 8)
    d.setFont('helvetica', 'bold')
    d.setFontSize(8)
    d.setTextColor(0)
    const userName = (t.userEmail || '').split('@')[0].toUpperCase()
    d.text(`PREPARED BY:   ${userName}`, M + 2, y + 5.5)
    y += 10

    // ── Footer ──
    const now = new Date()
    const stamp = `${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')}/${now.getFullYear()} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')} ${now.getHours() >= 12 ? 'PM' : 'AM'}`
    d.setFont('helvetica', 'italic')
    d.setFontSize(6)
    d.setTextColor(150)
    d.text('MCL WMS', M, y + 3)
    d.text(stamp, W / 2, y + 3, { align: 'center' })
    d.text(`PAGE ${di + 1}`, W - M, y + 3, { align: 'right' })
  }

  return d.output('blob')
}

// ── On-the-fly Pallet Control generation ────────────────────────────────
// Loads ULDs, pieces, and doc_receptions from Firestore for a given flight
// and generates the Pallet Control PDF without requiring pre-stored data.

export async function generatePalletControlOnTheFly(
  flightId: string,
  flightData: { id: string; flight_number?: string; airline?: string; flight_datetime: string; destinations?: string[] },
  userEmail: string,
): Promise<Blob | null> {
  // 1. Load ULDs for this flight
  const uldSnap = await getDocs(query(
    collection(db, 'buildup_ulds'),
    where('flight_id', '==', flightId),
  ))
  if (uldSnap.empty) return null
  const ulds: PdfUld[] = uldSnap.docs.map(d => {
    const data = d.data()
    return { id: d.id, uld_number: data.uld_number, conf: data.conf, type: data.type, destination: data.destination }
  })

  // 2. Load doc receptions for this flight (to get AWB info)
  const recSnap = await getDocs(query(
    collection(db, 'airfreight_doc_receptions'),
    where('flight_id', '==', flightId),
    where('status', 'in', ['in_physical', 'complete']),
  ))
  const receptions = recSnap.docs.map(d => ({ id: d.id, ...d.data() } as any))

  // 3. Load physical pieces for each reception
  const piecesResults = await Promise.all(
    receptions.map((rec: any) =>
      getDocs(query(
        collection(db, 'airfreight_physical_pieces'),
        where('doc_reception_id', '==', rec.id),
      ))
    )
  )

  const awbs: PdfAwb[] = receptions.map((rec: any) => ({
    awb_number: rec.awb_number || '',
    awb_2nd_leg: rec.awb_2nd_leg || null,
    mawb_number: rec.mawb_number || null,
    client_name: rec.client_name || '',
    destination: rec.destination || '',
    pieces_declared: rec.pieces || 0,
    chargeable_weight: rec.chargeable_weight || 0,
  }))

  const pieces: PdfPiece[] = []
  for (const result of piecesResults) {
    for (const d of result.docs) {
      const p = d.data()
      pieces.push({
        awb_number: p.awb_number || '',
        weight_kg: p.weight_kg || 0,
        packing_type: p.packing_type || '',
        uld_id: p.uld_id || null,
        comment: p.dist_comment || '',
      })
    }
  }

  // Only generate if there are pieces assigned to ULDs
  if (!pieces.some(p => p.uld_id)) return null

  return generatePalletControlPdf(flightData, awbs, pieces, ulds, userEmail)
}
