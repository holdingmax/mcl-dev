import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useReactToPrint } from 'react-to-print'
import { doc, getDoc, getDocs, collection } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import type { WSServiceOrder, WarehouseReceipt, WRLine } from '../../types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const html2pdf: any

interface WSDOData {
  id: string
  do_number: string
  so_id: string
  so_number: string
  client_name: string
  awb_number?: string
  pieces?: number
  weight?: number
  trucking_company: string
  driver_name: string
  custody_method: 'seal' | 'escort' | 'locked_vehicle'
  seal_number?: string
  escort_name?: string
  mcl_agent: string
  status: string
  created_at: string
}

const CUSTODY_LABELS: Record<string, string> = {
  seal: 'Tamper Seal',
  escort: 'Escort',
  locked_vehicle: 'Locked Vehicle',
}

export default function WSDeliveryOrderView() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const printRef = useRef<HTMLDivElement>(null)
  const pdfRef = useRef<HTMLDivElement>(null)
  const { gmailToken, refreshGmailToken } = useAuth()

  const [doData, setDoData] = useState<WSDOData | null>(null)
  const [so, setSo] = useState<WSServiceOrder | null>(null)
  const [wr, setWr] = useState<WarehouseReceipt | null>(null)
  const [lines, setLines] = useState<WRLine[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)

  useEffect(() => { if (id) loadData() }, [id])

  async function loadData() {
    setLoading(true)
    const doSnap = await getDoc(doc(db, 'ws_delivery_orders', id!))
    if (!doSnap.exists()) { setLoading(false); return }
    const d = { id: doSnap.id, ...doSnap.data() } as WSDOData
    setDoData(d)

    if (d.so_id) {
      const soSnap = await getDoc(doc(db, 'warehouse_service_orders', d.so_id))
      if (soSnap.exists()) {
        const soData = { id: soSnap.id, ...soSnap.data() } as WSServiceOrder
        setSo(soData)
        if (soData.wr_id) {
          const wrSnap = await getDoc(doc(db, 'warehouse_receipts', soData.wr_id))
          if (wrSnap.exists()) {
            setWr({ id: wrSnap.id, ...wrSnap.data() } as WarehouseReceipt)
            const lSnap = await getDocs(collection(db, 'warehouse_receipts', soData.wr_id, 'lines'))
            setLines(lSnap.docs.map(l => ({ id: l.id, ...l.data() } as WRLine)).sort((a, b) => (a.line_order || 0) - (b.line_order || 0)))
          }
        }
      }
    }
    setLoading(false)
  }

  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: doData?.do_number || 'DO',
  })

  async function handleDownloadPdf() {
    const el = pdfRef.current
    if (!el) return
    await html2pdf().set({
      margin: [4, 4],
      filename: `${doData?.do_number || 'DO'}.pdf`,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'letter', orientation: 'portrait' },
    }).from(el).save()
  }

  async function generatePdfBlob(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const el = pdfRef.current
      if (!el) { reject(new Error('No element')); return }
      html2pdf().set({
        margin: [4, 4],
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'letter', orientation: 'portrait' },
      }).from(el).outputPdf('blob').then(resolve).catch(reject)
    })
  }

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve((reader.result as string).split(',')[1])
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  async function createGmailDraft(token: string, rawMime: string): Promise<string> {
    const encoded = btoa(unescape(encodeURIComponent(rawMime))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { raw: encoded } }),
    })
    if (!res.ok) { const err = await res.json(); throw new Error(err?.error?.message || 'Gmail API error') }
    return (await res.json()).id
  }

  async function handleSendEmail() {
    if (!doData) return
    setSending(true)
    try {
      let token = gmailToken
      if (!token) { token = await refreshGmailToken(); if (!token) throw new Error('No se pudo obtener autorización de Gmail.') }

      const pdfBlob = await generatePdfBlob()
      const pdfBase64 = await blobToBase64(pdfBlob)

      const to = ''
      const subject = `Delivery Order ${doData.do_number} — ${doData.client_name}`
      const bodyText = `Estimados,\n\nAdjunto Delivery Order ${doData.do_number} para la SO ${doData.so_number}.\n\nCliente: ${doData.client_name}\nTransportista: ${doData.trucking_company}\nChofer: ${doData.driver_name}\n\nSaludos,\nMinCurl Logistics LLC`
      const filename = `${doData.do_number}.pdf`

      const boundary = 'MCL_BOUNDARY_' + Date.now()
      const mime = [
        `MIME-Version: 1.0`, `To: ${to}`, `Subject: ${subject}`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`, ``,
        `--${boundary}`, `Content-Type: text/plain; charset=UTF-8`, ``, bodyText, ``,
        `--${boundary}`, `Content-Type: application/pdf`, `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${filename}"`, ``, pdfBase64, ``,
        `--${boundary}--`,
      ].join('\r\n')

      let draftId: string
      try { draftId = await createGmailDraft(token, mime) } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : ''
        if (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('expired') || msg.toLowerCase().includes('401')) {
          const fresh = await refreshGmailToken()
          if (!fresh) throw new Error('Sesión de Gmail expirada. Por favor recarga la página.')
          draftId = await createGmailDraft(fresh, mime)
        } else { throw err }
      }

      window.open(`https://mail.google.com/mail/u/0/#drafts?compose=${draftId}`, '_blank')
      alert('Borrador creado en Gmail.')
    } catch (err: unknown) {
      alert('Error: ' + (err instanceof Error ? err.message : 'Error desconocido'))
    } finally { setSending(false) }
  }

  if (loading) return <Layout title="Delivery Order" backTo="/warehouse-services/delivery-orders"><div className="text-center py-20 text-gray-400">Loading...</div></Layout>
  if (!doData) return <Layout title="Delivery Order" backTo="/warehouse-services/delivery-orders"><div className="text-center py-20 text-gray-400">Not found</div></Layout>

  const pickupFrom = so?.service_items?.find(s => s.type === 'transport')?.pickup_from || '2323 NW 82nd Ave, Doral FL 33122 (MCL)'
  const deliverTo = so?.service_items?.find(s => s.type === 'transport')?.deliver_to || ''
  const totalQty = lines.length > 0
    ? lines.reduce((s, l) => s + (l.qty || 0), 0)
    : (so?.cargo_lines && so.cargo_lines.length > 0 ? so.cargo_lines.reduce((s, cl) => s + (cl.pieces || 0), 0) : 0)
  const totalCbm = lines.reduce((s, l) => s + (l.cbm || 0), 0)
  const totalWeight = lines.length > 0
    ? lines.reduce((s, l) => s + (l.weight_kg || 0), 0)
    : (so?.cargo_lines && so.cargo_lines.length > 0 ? so.cargo_lines.reduce((s, cl) => s + (cl.weight_kg || 0), 0) : 0)

  const PACKING_LABELS: Record<string, string> = { pallet: 'Pallet', box: 'Box', bag: 'Bag', drum: 'Drum', crate: 'Crate', bundle: 'Bundle', loose: 'Loose', other: 'Other' }

  const documentContent = (
    <div style={{ fontFamily: "'Helvetica Neue', Arial, sans-serif", padding: '40px 48px', background: '#fff', color: '#1f2937', fontSize: '11px', lineHeight: 1.4, position: 'relative', minHeight: '10.5in' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '3px solid #0f1d3a', paddingBottom: '12px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '48px', height: '48px', background: '#0f1d3a', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 900, fontSize: '13px', letterSpacing: '1px' }}>MCL</div>
          <div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: '#0f1d3a' }}>MinCurl Logistics LLC</div>
            <div style={{ fontSize: '9px', color: '#6b7280' }}>2323 NW 82nd Ave, Doral, FL 33122 | +1 (786) 534-5440</div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '20px', fontWeight: 900, color: '#0f1d3a', letterSpacing: '1px' }}>DELIVERY ORDER</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: '#2563eb', fontFamily: "'Courier New', monospace", marginTop: '2px' }}>{doData.do_number}</div>
          <div style={{ fontSize: '9px', color: '#6b7280', marginTop: '3px' }}>Date: {new Date(doData.created_at).toLocaleDateString('es-CL')}</div>
        </div>
      </div>

      {/* Order Information */}
      <div style={{ fontSize: '9px', fontWeight: 800, color: '#0f1d3a', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px', paddingBottom: '3px', borderBottom: '1.5px solid #e5e7eb' }}>Order Information</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #d1d5db', borderRadius: '4px', marginBottom: '14px' }}>
        <tbody>
          <tr>
            <td style={{ ...cellStyle }}>
              <div style={labelStyle}>Service Order</div>
              <div style={{ ...valueStyle, fontFamily: "'Courier New', monospace", color: '#2563eb' }}>{doData.so_number}</div>
            </td>
            <td style={{ ...cellStyle }}>
              <div style={labelStyle}>Client</div>
              <div style={valueStyle}>{doData.client_name}</div>
            </td>
          </tr>
          <tr>
            <td style={{ ...cellStyle }}>
              <div style={labelStyle}>AWB</div>
              <div style={{ ...valueStyle, fontFamily: "'Courier New', monospace" }}>{doData.awb_number || (so?.cargo_lines && so.cargo_lines.length > 0 ? so.cargo_lines.map(cl => cl.awb).filter(Boolean).join(', ') : null) || so?.awb_number || '—'}</div>
            </td>
            <td style={{ ...cellStyle }}>
              <div style={labelStyle}>Warehouse Receipt</div>
              <div style={{ ...valueStyle, fontFamily: "'Courier New', monospace", color: '#2563eb' }}>{wr?.wr_number || '—'}</div>
            </td>
          </tr>
          <tr>
            <td style={{ ...cellStyle }}>
              <div style={labelStyle}>Cargo Type</div>
              <div style={valueStyle}>{so?.cargo_type || 'General'} — {so?.cargo_mode === 'BOND' ? 'Bonded' : 'Local'}</div>
            </td>
            <td style={{ ...cellStyle }}>
              <div style={labelStyle}>Reference</div>
              <div style={valueStyle}>{so?.reference || '—'}</div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Route */}
      <div style={{ fontSize: '9px', fontWeight: 800, color: '#0f1d3a', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px', paddingBottom: '3px', borderBottom: '1.5px solid #e5e7eb' }}>Route</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '10px 14px', marginBottom: '14px' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '8px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' }}>Origin (Pick-up)</div>
          <div style={{ fontSize: '11px', fontWeight: 600, marginTop: '2px' }}>{pickupFrom}</div>
        </div>
        <div style={{ fontSize: '18px', color: '#2563eb', fontWeight: 900 }}>&rarr;</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '8px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' }}>Destination (Deliver to)</div>
          <div style={{ fontSize: '11px', fontWeight: 600, marginTop: '2px' }}>{deliverTo || '—'}</div>
        </div>
      </div>

      {/* Transport Details */}
      <div style={{ fontSize: '9px', fontWeight: 800, color: '#0f1d3a', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px', paddingBottom: '3px', borderBottom: '1.5px solid #e5e7eb' }}>Transport Details</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #d1d5db', marginBottom: '14px' }}>
        <tbody>
          <tr>
            <td style={{ ...cellStyle }}><div style={labelStyle}>Trucking Company</div><div style={valueStyle}>{doData.trucking_company}</div></td>
            <td style={{ ...cellStyle }}><div style={labelStyle}>Driver</div><div style={valueStyle}>{doData.driver_name}</div></td>
            <td style={{ ...cellStyle }}><div style={labelStyle}>Custody Method</div><div style={valueStyle}><span style={{ background: '#dbeafe', color: '#1e40af', fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '3px', textTransform: 'uppercase' }}>{CUSTODY_LABELS[doData.custody_method] || doData.custody_method}</span></div></td>
          </tr>
          <tr>
            <td style={{ ...cellStyle }}><div style={labelStyle}>{doData.custody_method === 'seal' ? 'Seal Number' : doData.custody_method === 'escort' ? 'Escort' : ''}</div><div style={{ ...valueStyle, fontFamily: "'Courier New', monospace" }}>{doData.seal_number || doData.escort_name || '—'}</div></td>
            <td style={{ ...cellStyle }}><div style={labelStyle}>MCL Agent</div><div style={valueStyle}>{doData.mcl_agent}</div></td>
            <td style={{ ...cellStyle }}><div style={labelStyle}>Departure Time</div><div style={valueStyle}>{new Date(doData.created_at).toLocaleString('es-CL')}</div></td>
          </tr>
        </tbody>
      </table>

      {/* Cargo Table */}
      <div style={{ fontSize: '9px', fontWeight: 800, color: '#0f1d3a', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px', paddingBottom: '3px', borderBottom: '1.5px solid #e5e7eb' }}>Cargo Details</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '14px', fontSize: '10px' }}>
        <thead>
          <tr>
            {['#', 'Type', 'Qty', 'L (cm)', 'W (cm)', 'H (cm)', 'CBM', 'Weight (kg)', 'Location'].map(h => (
              <th key={h} style={{ background: '#0f1d3a', color: '#fff', padding: '5px 7px', textAlign: 'left', fontWeight: 700, fontSize: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.length > 0 ? lines.map((l, i) => (
            <tr key={l.id || i}>
              <td style={tdStyle}>{i + 1}</td>
              <td style={tdStyle}>{PACKING_LABELS[l.packing_type] || l.packing_type}</td>
              <td style={tdStyle}>{l.qty}</td>
              <td style={tdStyle}>{l.length_cm || ''}</td>
              <td style={tdStyle}>{l.width_cm || ''}</td>
              <td style={tdStyle}>{l.height_cm || ''}</td>
              <td style={tdStyle}>{(l.cbm || 0).toFixed(3)}</td>
              <td style={tdStyle}>{l.weight_kg || ''}</td>
              <td style={tdStyle}>{l.location || ''}</td>
            </tr>
          )) : so?.cargo_lines && so.cargo_lines.length > 0 ? so.cargo_lines.map((cl: any, i: number) => (
            <tr key={i}>
              <td style={tdStyle}>{i + 1}</td>
              <td style={tdStyle}>{cl.awb || '—'}</td>
              <td style={tdStyle}>{cl.pieces || '—'}</td>
              <td style={tdStyle} colSpan={4}>{cl.reference || cl.po || ''}</td>
              <td style={tdStyle}>{cl.weight_kg || cl.weight || '—'}</td>
              <td style={tdStyle}>{cl.note || ''}</td>
            </tr>
          )) : (
            <tr>
              <td style={tdStyle}>1</td>
              <td style={tdStyle}>—</td>
              <td style={tdStyle}>{doData.pieces || so?.declared_pieces || '—'}</td>
              <td style={tdStyle} colSpan={4}></td>
              <td style={tdStyle}>{doData.weight || so?.declared_weight || '—'}</td>
              <td style={tdStyle}></td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2} style={{ ...tdStyle, fontWeight: 700, background: '#f3f4f6', borderTop: '2px solid #d1d5db' }}>TOTAL</td>
            <td style={{ ...tdStyle, fontWeight: 700, background: '#f3f4f6', borderTop: '2px solid #d1d5db' }}>{totalQty || doData.pieces || ''}</td>
            <td colSpan={3} style={{ ...tdStyle, background: '#f3f4f6', borderTop: '2px solid #d1d5db' }}></td>
            <td style={{ ...tdStyle, fontWeight: 700, background: '#f3f4f6', borderTop: '2px solid #d1d5db' }}>{totalCbm ? totalCbm.toFixed(3) : ''}</td>
            <td style={{ ...tdStyle, fontWeight: 700, background: '#f3f4f6', borderTop: '2px solid #d1d5db' }}>{totalWeight || doData.weight || ''} kg</td>
            <td style={{ ...tdStyle, background: '#f3f4f6', borderTop: '2px solid #d1d5db' }}></td>
          </tr>
        </tfoot>
      </table>

      {/* Signatures */}
      <div style={{ display: 'flex', gap: '40px', marginTop: '40px' }}>
        <div style={{ flex: 1 }}>
          <div style={{ height: '50px' }}></div>
          <div style={{ borderTop: '1.5px solid #1f2937', paddingTop: '5px' }}>
            <div style={{ fontSize: '9px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Released by (MCL Agent)</div>
            <div style={{ fontSize: '10px', color: '#9ca3af', marginTop: '2px' }}>Name: ________________________</div>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ height: '50px' }}></div>
          <div style={{ borderTop: '1.5px solid #1f2937', paddingTop: '5px' }}>
            <div style={{ fontSize: '9px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Received by (Driver)</div>
            <div style={{ fontSize: '10px', color: '#9ca3af', marginTop: '2px' }}>Name: ________________________</div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ position: 'absolute', bottom: '30px', left: '48px', right: '48px', textAlign: 'center', fontSize: '8px', color: '#9ca3af', borderTop: '1px solid #e5e7eb', paddingTop: '6px' }}>
        MinCurl Logistics LLC &bull; 2323 NW 82nd Ave, Doral, FL 33122 &bull; info@mincurllogistics.com &bull; +1 (786) 534-5440<br />
        This document authorizes the release and transport of the cargo described above.
      </div>
    </div>
  )

  return (
    <Layout title={doData.do_number} backTo="/warehouse-services/delivery-orders">
      <div className="max-w-4xl mx-auto px-4 py-6">
        {/* Action buttons */}
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => handlePrint()} className="bg-mcl-blue hover:bg-blue-900 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
            Print
          </button>
          <button onClick={handleDownloadPdf} className="bg-gray-600 hover:bg-gray-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            PDF
          </button>
          <button onClick={handleSendEmail} disabled={sending} className="bg-green-600 hover:bg-green-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
            {sending ? 'Sending...' : 'Email'}
          </button>
          <button onClick={() => navigate(`/warehouse-services/delivery-order/new?edit=${doData.id}`)} className="ml-auto text-sm text-gray-500 hover:text-mcl-blue px-3 py-2">
            Edit DO
          </button>
        </div>

        {/* Visible document */}
        <div ref={printRef} className="bg-white rounded-xl shadow-sm border overflow-hidden">
          {documentContent}
        </div>

        {/* Hidden PDF version */}
        <div style={{ position: 'absolute', left: '-9999px', top: 0 }}>
          <div ref={pdfRef} style={{ width: '8.5in' }}>
            {documentContent}
          </div>
        </div>
      </div>
    </Layout>
  )
}

// ── Inline styles for table cells ──
const cellStyle: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb' }
const labelStyle: React.CSSProperties = { fontSize: '8px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '1px' }
const valueStyle: React.CSSProperties = { fontSize: '11px', fontWeight: 600, color: '#1f2937' }
const tdStyle: React.CSSProperties = { padding: '5px 7px', borderBottom: '1px solid #e5e7eb', color: '#374151' }
