import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { doc, getDoc } from 'firebase/firestore'
import { storage, db } from './firebase'
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib'

// ── Types ────────────────────────────────────────────────────────────────

export interface PalletEntry {
  pallet_no: string
  pieces: number
}

export interface DistributionAwb {
  awb: string
  pallets: PalletEntry[]
}

export interface DistributionData {
  carrier: string
  flight: string
  destination: string
  date: string
  entries: DistributionAwb[]
}

export interface AwbPage {
  pageIndex: number
  awb_number: string | null
  imageDataUrl: string  // for preview
  pdfPageBytes: ArrayBuffer  // original PDF page bytes
  pallets: PalletEntry[]
  matched: boolean
  // Position where pallets should be written (percentage of image dimensions)
  palletPos?: { xPct: number; yPct: number }
}

// ── PDF to images (using canvas) ─────────────────────────────────────────

/** Convert a PDF ArrayBuffer to an array of PNG base64 strings (one per page) */
export async function pdfToImages(pdfBytes: ArrayBuffer): Promise<string[]> {
  const pdf = await PDFDocument.load(pdfBytes)
  const pageCount = pdf.getPageCount()
  const images: string[] = []

  // We need to render each page as an image. Since pdf-lib can't render,
  // we split each page into a separate single-page PDF and use pdfjsLib.
  // Alternatively, we use the canvas approach with pdfjs-dist.
  // For simplicity, we'll use an offscreen approach via the browser's PDF rendering.

  for (let i = 0; i < pageCount; i++) {
    const singleDoc = await PDFDocument.create()
    const [page] = await singleDoc.copyPages(pdf, [i])
    singleDoc.addPage(page)
    const singleBytes = await singleDoc.save()

    // Use pdfjs to render
    const base64 = await renderPdfPageToBase64(singleBytes)
    images.push(base64)
  }

  return images
}

/** Render a single-page PDF to a base64 PNG string using pdfjs */
async function renderPdfPageToBase64(pdfBytes: Uint8Array): Promise<string> {
  // Dynamic import of pdfjs
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`

  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes })
  const pdf = await loadingTask.promise
  const page = await pdf.getPage(1)

  const scale = 2.0  // 2x for good quality
  const viewport = page.getViewport({ scale })

  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  const ctx = canvas.getContext('2d')!

  await page.render({ canvasContext: ctx, viewport }).promise

  // Get base64 without the data:image/png;base64, prefix
  const dataUrl = canvas.toDataURL('image/png')
  const base64 = dataUrl.split(',')[1]

  canvas.remove()
  return base64
}

/** Split a PDF into individual page ArrayBuffers */
export async function splitPdfPages(pdfBytes: ArrayBuffer): Promise<ArrayBuffer[]> {
  const pdf = await PDFDocument.load(pdfBytes)
  const pageCount = pdf.getPageCount()
  const pages: ArrayBuffer[] = []

  for (let i = 0; i < pageCount; i++) {
    const singleDoc = await PDFDocument.create()
    const [page] = await singleDoc.copyPages(pdf, [i])
    singleDoc.addPage(page)
    const bytes = await singleDoc.save()
    pages.push(bytes.buffer as ArrayBuffer)
  }

  return pages
}

// ── Anthropic API (direct from browser) ──────────────────────────────────

let _anthropicKey: string | null = null

async function getAnthropicKey(): Promise<string> {
  if (_anthropicKey) return _anthropicKey
  const snap = await getDoc(doc(db, 'config', 'anthropic_key'))
  if (!snap.exists()) throw new Error('Anthropic API key not configured in Firestore (config/anthropic_key)')
  _anthropicKey = snap.data().key as string
  return _anthropicKey
}

interface ClaudeContent {
  type: 'image' | 'document' | 'text'
  source?: { type: 'base64'; media_type: string; data: string }
  text?: string
}

async function callClaude(systemPrompt: string, content: ClaudeContent | ClaudeContent[]): Promise<string> {
  const apiKey = await getAnthropicKey()
  const contentArray = Array.isArray(content) ? content : [content]
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: contentArray,
      }],
    }),
  })
  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Anthropic API error ${resp.status}: ${err}`)
  }
  const data = await resp.json()
  return data.content[0].text
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export async function callProcessDistribution(pdfBytes: ArrayBuffer): Promise<DistributionData> {
  const systemPrompt = `You are an OCR assistant that extracts data from airline cargo distribution sheets.

STEP 1: Extract header info:
- carrier: airline name
- flight: flight number
- destination: destination airport code
- date: date of the distribution

STEP 2: Go through the table ROW BY ROW, from top to bottom. For each row, read:
- The AWB number (if present in that row; if blank, it belongs to the previous AWB)
- The ULD/pallet code (e.g. PMC19406R9, PAG56134R7, AKE12345, PLA99999, etc.)
- The pieces count

IMPORTANT: Do NOT skip any row. Every single row with a pallet code must appear in the output.
If an AWB has 3 rows with different pallet codes, all 3 must be in its pallets array.
Double-check: count the total rows in the table and verify your output has the same count.

Return ONLY valid JSON (no markdown, no code fences, no explanation):
{
  "carrier": "...",
  "flight": "...",
  "destination": "...",
  "date": "...",
  "entries": [
    {
      "awb": "XXX-XXXXXXXX",
      "pallets": [
        { "pallet_no": "PMC19406R9", "pieces": 53 },
        { "pallet_no": "PAG56134R7", "pieces": 22 }
      ]
    }
  ]
}`

  const pdfBase64 = arrayBufferToBase64(pdfBytes)
  const text = await callClaude(systemPrompt, {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
  })
  // Parse JSON from response (handle possible markdown wrapping)
  const jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
  return JSON.parse(jsonStr) as DistributionData
}

export async function callIdentifyAwbs(pages: { pdfBytes: ArrayBuffer; pageIndex: number }[], knownAwbs?: string[]): Promise<{ pageIndex: number; awb_number: string | null }[]> {
  const knownList = knownAwbs && knownAwbs.length > 0
    ? `\nThe AWB numbers should be from this list:\n${knownAwbs.map(a => `- ${a}`).join('\n')}`
    : ''

  const systemPrompt = `You are an OCR assistant that identifies Air Waybill (AWB) numbers from scanned cargo documents.

You will receive ${pages.length} PDF documents. For each document, identify the AWB number.
The AWB number format is: XXX-XXXXXXXX (3 digits, dash, 8 digits), e.g. 045-22209040.
It typically appears at the top-left and top-right corners of the document.${knownList}

Return ONLY valid JSON (no markdown, no explanation) as an array with one entry per document, in order:
[
  { "page": 1, "awb": "045-22209040" },
  { "page": 2, "awb": "045-22209051" },
  { "page": 3, "awb": "045-22209062" }
]
Use "null" (without quotes, the JSON null value) if you truly cannot identify an AWB number for a document.`

  // Build content array: one text label + one document per page
  const contentArray: ClaudeContent[] = []
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const pdfBase64 = arrayBufferToBase64(page.pdfBytes)
    contentArray.push({
      type: 'text',
      text: `Document ${i + 1} of ${pages.length}:`,
    })
    contentArray.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
    })
  }

  try {
    const text = await callClaude(systemPrompt, contentArray)
    const jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    const parsed = JSON.parse(jsonStr) as { page: number; awb: string | null }[]

    return parsed.map((entry, i) => ({
      pageIndex: pages[i]?.pageIndex ?? i,
      awb_number: entry.awb,
    }))
  } catch (err) {
    console.error('Error identifying AWBs:', err)
    // Fallback: return all as unidentified
    return pages.map(p => ({ pageIndex: p.pageIndex, awb_number: null }))
  }
}

// ── Write pallets on AWB PDF ─────────────────────────────────────────────

const PALLET_LINE_HEIGHT = 10
const PALLET_FONT_SIZE = 8

export async function writePalletsOnAwb(
  pdfBytes: ArrayBuffer,
  pallets: PalletEntry[],
  palletPos?: { xPct: number; yPct: number },
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(pdfBytes)
  const page = doc.getPage(0)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const rotation = page.getRotation().angle
  const pageWidth = page.getWidth()   // PDF native: 792
  const pageHeight = page.getHeight() // PDF native: 612

  // Visual dimensions (what user sees — portrait for rotated AWBs)
  const isRotated = rotation === 90 || rotation === 270
  const visualWidth = isRotated ? pageHeight : pageWidth
  const visualHeight = isRotated ? pageWidth : pageHeight

  const xPct = palletPos?.xPct ?? 0.87
  const yPct = palletPos?.yPct ?? 0.52

  for (let i = 0; i < pallets.length; i++) {
    const p = pallets[i]
    const text = `${p.pallet_no} (${p.pieces})`

    if (rotation === 270) {
      // Verified empirically with test PDF
      const nx = (1 - yPct) * pageWidth - i * PALLET_LINE_HEIGHT
      const ny = (1 - xPct) * pageHeight
      page.drawText(text, { x: nx, y: ny, size: PALLET_FONT_SIZE, font, color: rgb(0, 0, 0), rotate: degrees(270) })
    } else if (rotation === 90) {
      const nx = yPct * pageWidth + i * PALLET_LINE_HEIGHT
      const ny = xPct * pageHeight
      page.drawText(text, { x: nx, y: ny, size: PALLET_FONT_SIZE, font, color: rgb(0, 0, 0), rotate: degrees(90) })
    } else {
      const nx = xPct * pageWidth
      const ny = pageHeight - (yPct * pageHeight) - i * PALLET_LINE_HEIGHT
      page.drawText(text, { x: nx, y: ny, size: PALLET_FONT_SIZE, font, color: rgb(0, 0, 0) })
    }
  }

  const bytes = await doc.save()
  return bytes.buffer as ArrayBuffer
}

/** Write pallets on all odd pages (0,2,4,6,8) of a full 10-page AWB PDF.
 *  Returns the modified full PDF as ArrayBuffer. */
export async function writePalletsOnFullAwb(
  pdfBytes: ArrayBuffer,
  pallets: PalletEntry[],
  palletPos?: { xPct: number; yPct: number },
): Promise<ArrayBuffer> {
  const pdfDoc = await PDFDocument.load(pdfBytes)
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const pageCount = pdfDoc.getPageCount()
  // Odd pages in 1-based = even indices in 0-based: 0, 2, 4, 6, 8 + page 10 (index 9)
  const targetIndices = [0, 2, 4, 6, 8, 9].filter(i => i < pageCount)

  const xPct = palletPos?.xPct ?? 0.87
  const yPct = palletPos?.yPct ?? 0.52

  for (const pi of targetIndices) {
    const page = pdfDoc.getPage(pi)
    const rotation = page.getRotation().angle
    const pageWidth = page.getWidth()
    const pageHeight = page.getHeight()

    for (let i = 0; i < pallets.length; i++) {
      const p = pallets[i]
      const text = `${p.pallet_no} (${p.pieces})`

      if (rotation === 270) {
        const nx = (1 - yPct) * pageWidth - i * PALLET_LINE_HEIGHT
        const ny = (1 - xPct) * pageHeight
        page.drawText(text, { x: nx, y: ny, size: PALLET_FONT_SIZE, font, color: rgb(0, 0, 0), rotate: degrees(270) })
      } else if (rotation === 90) {
        const nx = yPct * pageWidth + i * PALLET_LINE_HEIGHT
        const ny = xPct * pageHeight
        page.drawText(text, { x: nx, y: ny, size: PALLET_FONT_SIZE, font, color: rgb(0, 0, 0), rotate: degrees(90) })
      } else {
        const nx = xPct * pageWidth
        const ny = pageHeight - (yPct * pageHeight) - i * PALLET_LINE_HEIGHT
        page.drawText(text, { x: nx, y: ny, size: PALLET_FONT_SIZE, font, color: rgb(0, 0, 0) })
      }
    }
  }

  const bytes = await pdfDoc.save()
  return bytes.buffer as ArrayBuffer
}

// ── Upload modified AWB to Firebase Storage ──────────────────────────────

export async function uploadModifiedAwb(
  pdfBytes: ArrayBuffer,
  awbNumber: string,
): Promise<{ url: string; storagePath: string }> {
  const filename = `AWB_${awbNumber.replace(/[^a-zA-Z0-9-]/g, '_')}_cut.pdf`
  const storagePath = `airfreight/awb-cut/${Date.now()}_${filename}`
  const storageRef = ref(storage, storagePath)

  await uploadBytes(storageRef, new Uint8Array(pdfBytes), {
    contentType: 'application/pdf',
  })

  const url = await getDownloadURL(storageRef)
  return { url, storagePath }
}
