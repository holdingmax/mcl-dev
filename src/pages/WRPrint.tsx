import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useReactToPrint } from 'react-to-print'
import { db } from '../lib/firebase'
import { doc, getDoc, getDocs, collection, query, where, orderBy } from 'firebase/firestore'
import { WarehouseReceipt, WRLine, SkuLine, Consignee, Client } from '../types'
import WRDocument from '../components/WRDocument'
import { WR_EMAIL_RECIPIENTS, MCL_CC_RECIPIENTS } from '../data/emailRecipients'
import { printLabels } from '../lib/printLabels'
import { useAuth } from '../contexts/AuthContext'

// html2pdf.js does not ship official TS types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const html2pdf: any

export default function WRPrint() {
  const { id } = useParams()
  const navigate = useNavigate()
  const printRef  = useRef<HTMLDivElement>(null)
  const pdfRef    = useRef<HTMLDivElement>(null)
  const { gmailToken, refreshGmailToken } = useAuth()

  const [wr, setWR]             = useState<WarehouseReceipt | null>(null)
  const [lines, setLines]       = useState<WRLine[]>([])
  const [skuLines, setSkuLines] = useState<SkuLine[]>([])
  const [loading, setLoading]   = useState(true)
  const [sending, setSending]   = useState(false)
  const [emailTooltip, setEmailTooltip] = useState('')

  useEffect(() => {
    if (id) loadData()
  }, [id])

  async function loadData() {
    const [wrSnap, linesSnap, skuSnap] = await Promise.all([
      getDoc(doc(db, 'warehouse_receipts', id!)),
      getDocs(query(collection(db, 'warehouse_receipts', id!, 'lines'), orderBy('line_order'))),
      getDocs(collection(db, 'warehouse_receipts', id!, 'sku_lines')),
    ])

    if (wrSnap.exists()) {
      const wrData = { id: wrSnap.id, ...wrSnap.data() } as WarehouseReceipt
      if (wrData.consignee_id) {
        const consSnap = await getDoc(doc(db, 'consignees', wrData.consignee_id))
        if (consSnap.exists()) {
          wrData.consignee = { id: consSnap.id, ...consSnap.data() } as Consignee
        }
      } else if (wrData.consignee_name) {
        wrData.consignee = { id: '', name: wrData.consignee_name, full_address: '', notify_to: wrData.notify_to || '' }
      }
      setWR(wrData)

      // Resolve email tooltip (non-blocking)
      try {
        const isWS = (wrData as any).source === 'warehouse_services'
        if (isWS) {
          let names: string[] = []
          const clientId = (wrData as any).client_id
          if (clientId) {
            const wsClSnap = await getDoc(doc(db, 'warehouse_service_clients', clientId))
            if (wsClSnap.exists()) {
              names = (wsClSnap.data().email_recipients || []).filter((r: any) => r.email).map((r: any) => r.name || r.email)
            }
          }
          setEmailTooltip(names.length > 0 ? `Enviar a: ${names.join(', ')}` : 'No recipients configured for this client')
        } else {
          setEmailTooltip(`Enviar a: ${WR_EMAIL_RECIPIENTS.map(r => r.name).join(', ')}`)
        }
      } catch { setEmailTooltip('Email') }
    }

    setLines(linesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as WRLine[])
    setSkuLines(skuSnap.docs.map(d => ({ id: d.id, ...d.data() })) as SkuLine[])
    setLoading(false)
  }

  const handlePrint = useReactToPrint({
    content: () => printRef.current,
    documentTitle: wr?.wr_number || 'WR',
  })

  // ── PDF generation ──────────────────────────────────────────────────────────
  async function generatePdfBlob(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const element = pdfRef.current
      if (!element) { reject(new Error('No element')); return }

      html2pdf()
        .set({
          margin:      [8, 8],
          filename:    `${wr?.wr_number || 'WR'}.pdf`,
          image:       { type: 'jpeg', quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF:       { unit: 'mm', format: 'letter', orientation: 'portrait' },
        })
        .from(element)
        .outputPdf('blob')
        .then(resolve)
        .catch(reject)
    })
  }

  // ── MIME builder ────────────────────────────────────────────────────────────
  function buildMimeMessage(
    to: string,
    subject: string,
    bodyText: string,
    pdfBase64: string,
    filename: string,
    photos: { base64: string; mimeType: string; name: string }[] = []
  ): string {
    const boundary = 'MCL_BOUNDARY_' + Date.now()
    const cc = MCL_CC_RECIPIENTS.map(r => r.email).join(', ')
    const parts = [
      `MIME-Version: 1.0`,
      `To: ${to}`,
      `Cc: ${cc}`,
      `Subject: ${subject}`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=UTF-8`,
      ``,
      bodyText,
      ``,
      `--${boundary}`,
      `Content-Type: application/pdf`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${filename}"`,
      ``,
      pdfBase64,
      ``,
    ]
    photos.forEach(p => {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${p.mimeType}`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${p.name}"`,
        ``,
        p.base64,
        ``
      )
    })
    parts.push(`--${boundary}--`)
    return parts.join('\r\n')
  }

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload  = () => resolve((reader.result as string).split(',')[1])
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  // ── Create Gmail Draft ─────────────────────────────────────────────────────
  async function createGmailDraft(token: string, rawMime: string): Promise<string> {
    const encoded = btoa(unescape(encodeURIComponent(rawMime)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ message: { raw: encoded } }),
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err?.error?.message || 'Gmail API error')
    }
    const data = await res.json()
    return data.id
  }

  // ── Main handler ────────────────────────────────────────────────────────────
  async function handleSendEmail() {
    if (!wr) return
    setSending(true)
    try {
      // 1. Get or refresh token
      let token = gmailToken
      if (!token) {
        token = await refreshGmailToken()
        if (!token) throw new Error('No se pudo obtener autorización de Gmail.')
      }

      // 2. Generate PDF blob
      const pdfBlob   = await generatePdfBlob()
      const pdfBase64 = await blobToBase64(pdfBlob)

      // 3. Collect line photos
      const photos: { base64: string; mimeType: string; name: string }[] = []
      let photoIdx = 1
      for (const line of lines) {
        const urls = line.photo_urls?.length ? line.photo_urls : (line.photo_url ? [line.photo_url] : [])
        for (const dataUrl of urls) {
          const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
          if (match) {
            photos.push({ mimeType: match[1], base64: match[2], name: `foto_linea${line.line_order}_${photoIdx++}.jpg` })
          }
        }
      }

      // 4. Resolve recipients from clients
      let recipients: { name: string; email: string }[] = []
      const isWS = (wr as any).source === 'warehouse_services'

      if (isWS) {
        // Warehouse Services: look up warehouse_service_clients by client_id or name
        const clientId = (wr as any).client_id
        if (clientId) {
          const wsClSnap = await getDoc(doc(db, 'warehouse_service_clients', clientId))
          if (wsClSnap.exists()) {
            const wsClient = wsClSnap.data()
            for (const r of wsClient.email_recipients || []) {
              if (r.email) recipients.push({ name: r.name || '', email: r.email })
            }
          }
        }
        if (recipients.length === 0 && wr.client_name) {
          const wsClSnap2 = await getDocs(query(collection(db, 'warehouse_service_clients'), where('name', '==', wr.client_name)))
          for (const d of wsClSnap2.docs) {
            for (const r of d.data().email_recipients || []) {
              if (r.email) recipients.push({ name: r.name || '', email: r.email })
            }
          }
        }
      } else {
        // Seafreight: look up clients collection
        const destination = wr.to_port || ''
        if (wr.client_name) {
          const clSnap = await getDocs(query(collection(db, 'clients'), where('name', '==', wr.client_name)))
          for (const d of clSnap.docs) {
            const client = d.data() as Client
            for (const r of client.email_recipients || []) {
              if (!r.notify_wr || !r.email) continue
              if (r.destination && destination && r.destination !== destination) continue
              recipients.push({ name: r.name, email: r.email })
            }
          }
        }
        // Fallback to hardcoded only for seafreight
        if (recipients.length === 0) recipients = WR_EMAIL_RECIPIENTS
      }

      // Deduplicate by email
      const seen = new Set<string>()
      recipients = recipients.filter(r => { if (seen.has(r.email)) return false; seen.add(r.email); return true })

      // Resolve CC from config
      let ccList = MCL_CC_RECIPIENTS
      const ccSnap = await getDoc(doc(db, 'config', 'email_settings'))
      if (ccSnap.exists() && ccSnap.data().mcl_cc_recipients?.length) {
        ccList = ccSnap.data().mcl_cc_recipients
      }

      const to       = recipients.map(r => r.email).join(', ')
      const subject  = `${wr.wr_number} - PO ${wr.po_number}`
      const bodyText = `Estimados,\n\nAdjunto WHR de la PO ${wr.po_number}${photos.length ? ` con ${photos.length} foto(s) de recepción física` : ''}.\n\nMuchas gracias,\nMinCurl Logistics`
      const filename = `${wr.wr_number}.pdf`

      // Override CC in MIME builder
      const boundary = 'MCL_BOUNDARY_' + Date.now()
      const cc = ccList.map(r => r.email).join(', ')
      const mimeParts = [
        `MIME-Version: 1.0`, `To: ${to}`, `Cc: ${cc}`, `Subject: ${subject}`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`, ``,
        `--${boundary}`, `Content-Type: text/plain; charset=UTF-8`, ``, bodyText, ``,
        `--${boundary}`, `Content-Type: application/pdf`, `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${filename}"`, ``, pdfBase64, ``,
      ]
      photos.forEach(p => {
        mimeParts.push(`--${boundary}`, `Content-Type: ${p.mimeType}`, `Content-Transfer-Encoding: base64`,
          `Content-Disposition: attachment; filename="${p.name}"`, ``, p.base64, ``)
      })
      mimeParts.push(`--${boundary}--`)
      const mime = mimeParts.join('\r\n')

      // 5. Create draft — retry once with fresh token if 401
      let draftId: string
      try {
        draftId = await createGmailDraft(token, mime)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : ''
        if (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('expired') || msg.toLowerCase().includes('401')) {
          const fresh = await refreshGmailToken()
          if (!fresh) throw new Error('Sesión de Gmail expirada. Por favor recarga la página.')
          draftId = await createGmailDraft(fresh, mime)
        } else {
          throw err
        }
      }

      window.open(`https://mail.google.com/mail/u/0/#drafts?compose=${draftId}`, '_blank')
      alert(`Borrador creado. Se abrió Gmail para revisar y enviar.\nDestinatarios: ${recipients.map(r => r.name).join(', ')}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error desconocido'
      alert(`Error al enviar mail: ${msg}`)
    } finally {
      setSending(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-400">Cargando...</p>
      </div>
    )
  }

  if (!wr) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">WR no encontrado.</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Toolbar — hidden on print */}
      <div className="print:hidden bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => {
            if (wr?.source === 'warehouse_services' && wr?.so_id) {
              navigate(`/warehouse-services/orders/${wr.so_id}`)
            } else {
              navigate('/sea')
            }
          }}
          className="flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Volver
        </button>

        <span className="text-sm font-semibold text-gray-700">{wr.wr_number}</span>

        <div className="flex items-center gap-2">
          <button
            onClick={() => wr && printLabels(wr, lines)}
            className="flex items-center gap-2 bg-amber-500 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-amber-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5l5 5v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2zm7 0v5h5" />
            </svg>
            Imprimir Etiquetas
          </button>
          <button
            onClick={handleSendEmail}
            disabled={sending}
            className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-green-700 transition-colors disabled:opacity-50"
            title={emailTooltip}
          >
            {sending ? (
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            )}
            {sending ? 'Enviando...' : 'Enviar Mail'}
          </button>

          <button
            onClick={() => handlePrint()}
            className="flex items-center gap-2 bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            Imprimir / PDF
          </button>
        </div>
      </div>

      {/* Document preview */}
      <div className="print:p-0 p-4 md:p-8 flex justify-center">
        <div className="print:shadow-none print:w-full bg-white shadow-lg w-full max-w-4xl">
          <WRDocument ref={printRef} wr={wr} lines={lines} skuLines={skuLines} />
        </div>
      </div>

      {/* Hidden document used only for PDF email attachment (fewer empty rows) */}
      <div style={{ position: 'absolute', left: '-9999px', top: 0, width: '816px' }}>
        <WRDocument ref={pdfRef} wr={wr} lines={lines} skuLines={skuLines} minRows={lines.length + 2} />
      </div>

    </div>
  )
}
