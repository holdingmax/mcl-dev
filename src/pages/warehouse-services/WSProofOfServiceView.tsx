import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useReactToPrint } from 'react-to-print'
import { doc, getDoc, getDocs, collection, query, where } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import type { WSServiceOrder, WarehouseReceipt, WRLine, WSDeliveryOrder, WSDeliveryTracking } from '../../types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const html2pdf: any

const SERVICE_LABELS: Record<string, string> = {
  screening_k9: 'Screening K9',
  screening_xray: 'Screening X-Ray',
  screening_manual: 'Screening Manual',
  transport: 'Transport',
  storage: 'Storage',
  in_out: 'In/Out',
  repack: 'Repack',
  dg_inspection: 'DG Inspection',
  breakdown_bup: 'Breakdown BUP',
}

const PACKING_LABELS: Record<string, string> = { pallet: 'Pallet', box: 'Box', bag: 'Bag', drum: 'Drum', crate: 'Crate', bundle: 'Bundle', loose: 'Loose', other: 'Other' }

export default function WSProofOfServiceView() {
  const { soId } = useParams<{ soId: string }>()
  const navigate = useNavigate()
  const printRef = useRef<HTMLDivElement>(null)
  const pdfRef = useRef<HTMLDivElement>(null)
  const { gmailToken, refreshGmailToken } = useAuth()

  const [order, setOrder] = useState<WSServiceOrder | null>(null)
  const [wr, setWr] = useState<WarehouseReceipt | null>(null)
  const [lines, setLines] = useState<WRLine[]>([])
  const [wsDoData, setWsDoData] = useState<WSDeliveryOrder | null>(null)
  const [wsTrackingData, setWsTrackingData] = useState<WSDeliveryTracking | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)

  useEffect(() => { if (soId) loadData() }, [soId])

  async function loadData() {
    setLoading(true)
    const soSnap = await getDoc(doc(db, 'warehouse_service_orders', soId!))
    if (!soSnap.exists()) { setLoading(false); return }
    const so = { id: soSnap.id, ...soSnap.data() } as WSServiceOrder
    setOrder(so)

    if (so.wr_id) {
      const wrSnap = await getDoc(doc(db, 'warehouse_receipts', so.wr_id))
      if (wrSnap.exists()) {
        setWr({ id: wrSnap.id, ...wrSnap.data() } as WarehouseReceipt)
        const lSnap = await getDocs(collection(db, 'warehouse_receipts', so.wr_id, 'lines'))
        setLines(lSnap.docs.map(l => ({ id: l.id, ...l.data() } as WRLine)).sort((a, b) => (a.line_order || 0) - (b.line_order || 0)))
      }
    }

    // Load DO + tracking for transport-only
    if (so.transport_only && (so as any).do_ids?.length) {
      const doId = (so as any).do_ids[0]
      const doSnap = await getDoc(doc(db, 'ws_delivery_orders', doId))
      if (doSnap.exists()) {
        const doData = { id: doSnap.id, ...doSnap.data() } as WSDeliveryOrder
        setWsDoData(doData)
        if (doData.tracking_id) {
          const tSnap = await getDoc(doc(db, 'ws_delivery_tracking', doData.tracking_id))
          if (tSnap.exists()) setWsTrackingData({ id: tSnap.id, ...tSnap.data() } as WSDeliveryTracking)
        }
      }
    }
    setLoading(false)
  }

  const docPrefix = order?.transport_only ? 'POD' : 'POS'

  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: order ? `${docPrefix}_${order.so_number}` : docPrefix,
  })

  async function handleDownloadPdf() {
    const el = pdfRef.current
    if (!el) return
    await html2pdf().set({
      margin: [4, 4],
      filename: `${docPrefix}_${order?.so_number || docPrefix}.pdf`,
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
    if (!order) return
    setSending(true)
    try {
      let token = gmailToken
      if (!token) { token = await refreshGmailToken(); if (!token) throw new Error('No se pudo obtener autorización de Gmail.') }

      const pdfBlob = await generatePdfBlob()
      const pdfBase64 = await blobToBase64(pdfBlob)

      const docLabel = order.transport_only ? 'Proof of Delivery' : 'Proof of Service'
      const filePrefix = order.transport_only ? 'POD' : 'POS'
      const to = ''
      const subject = `${docLabel} ${order.so_number} — ${order.client_name}`
      const bodyText = `Estimados,\n\nAdjunto ${docLabel} para la SO ${order.so_number}.\n\nCliente: ${order.client_name}\nRecibido por: ${order.pod_receiver || '—'}\nFecha: ${order.pod_at ? new Date(order.pod_at).toLocaleString('es-CL') : '—'}\n\nSaludos,\nMinCurl Logistics LLC`
      const filename = `${filePrefix}_${order.so_number}.pdf`

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

  if (loading) return <Layout title="Loading..." backTo="/warehouse-services"><div className="text-center py-20 text-gray-400">Loading...</div></Layout>
  if (!order || !order.pod_at) return <Layout title="Document" backTo="/warehouse-services"><div className="text-center py-20 text-gray-400">Not found or not confirmed</div></Layout>

  const isTransportOnly = !!order.transport_only
  const isBreakdownBup = !!(order.breakdown_awbs?.length)
  const cargoLines: { awb: string; reference: string; pieces: number; weight_kg: number; note: string }[] = (order as any).cargo_lines || []
  const breakdownAwbs = order.breakdown_awbs || []
  const driverName = wsDoData?.driver_name || wsTrackingData?.driver_name || ''
  const truckingCompany = wsDoData?.trucking_company || wsTrackingData?.vendor_name || ''
  const transportType = (order as any).transport_type || wsDoData?.transport_type || 'loose'
  const bupCount = (order as any).bup_count || wsDoData?.bup_count || 0
  const uldNumbers: string[] = (order as any).uld_numbers || wsDoData?.uld_numbers || []
  const pickupFrom = (order as any).pickup_from || wsDoData?.pickup_from || ''
  const deliverTo = (order as any).deliver_to || wsDoData?.deliver_to || ''
  const doNumber = wsDoData?.do_number || ''

  const totalQty = isTransportOnly
    ? cargoLines.reduce((s, l) => s + (l.pieces || 0), 0) || order.declared_pieces
    : lines.reduce((s, l) => s + (l.qty || 0), 0)
  const totalCbm = lines.reduce((s, l) => s + (l.cbm || 0), 0)
  const totalWeight = isTransportOnly
    ? cargoLines.reduce((s, l) => s + (l.weight_kg || 0), 0) || order.declared_weight
    : lines.reduce((s, l) => s + (l.weight_kg || 0), 0)
  const completedServices = order.service_items.filter(s => s.status === 'completed')

  // Green theme colors
  const GREEN = '#065f46'
  const GREEN_LIGHT = '#f0fdf4'
  const GREEN_BORDER = '#bbf7d0'
  const GREEN_ACCENT = '#059669'

  const documentContent = (
    <div style={{ fontFamily: "'Helvetica Neue', Arial, sans-serif", padding: '40px 48px', background: '#fff', color: '#1f2937', fontSize: '11px', lineHeight: 1.4, position: 'relative', minHeight: '10.5in' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: `3px solid ${GREEN}`, paddingBottom: '12px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '48px', height: '48px', background: GREEN, borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 900, fontSize: '13px', letterSpacing: '1px' }}>MCL</div>
          <div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: GREEN }}>MinCurl Logistics LLC</div>
            <div style={{ fontSize: '9px', color: '#6b7280' }}>2323 NW 82nd Ave, Doral, FL 33122 | +1 (786) 534-5440</div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '20px', fontWeight: 900, color: GREEN, letterSpacing: '1px' }}>{isTransportOnly ? 'PROOF OF DELIVERY' : 'PROOF OF SERVICE'}</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: GREEN_ACCENT, fontFamily: "'Courier New', monospace", marginTop: '2px' }}>{order.so_number}</div>
          {doNumber && <div style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280', fontFamily: "'Courier New', monospace" }}>{doNumber}</div>}
          <div style={{ fontSize: '9px', color: '#6b7280', marginTop: '3px' }}>Completed: {new Date(order.pod_at).toLocaleString('es-CL')}</div>
        </div>
      </div>

      {/* Order Information */}
      <div style={{ fontSize: '9px', fontWeight: 800, color: GREEN, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px', paddingBottom: '3px', borderBottom: `1.5px solid ${GREEN_BORDER}` }}>Order Information</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #d1d5db', marginBottom: '14px' }}>
        <tbody>
          <tr>
            <td style={cellStyle}><div style={labelStyle}>Service Order</div><div style={{ ...valueStyle, fontFamily: "'Courier New', monospace", color: GREEN_ACCENT }}>{order.so_number}</div></td>
            <td style={cellStyle}><div style={labelStyle}>Client</div><div style={valueStyle}>{order.client_name}</div></td>
          </tr>
          {isTransportOnly ? (
            <>
              <tr>
                <td style={cellStyle}><div style={labelStyle}>Delivery Order</div><div style={{ ...valueStyle, fontFamily: "'Courier New', monospace", color: GREEN_ACCENT }}>{doNumber || '—'}</div></td>
                <td style={cellStyle}><div style={labelStyle}>Transport Type</div><div style={valueStyle}>{transportType === 'bup' ? `BUP (${bupCount || 0})` : 'Loose'}{uldNumbers.length > 0 ? ` — ULD: ${uldNumbers.join(', ')}` : ''}</div></td>
              </tr>
              <tr>
                <td style={cellStyle}><div style={labelStyle}>Pickup From</div><div style={valueStyle}>{pickupFrom || '—'}</div></td>
                <td style={cellStyle}><div style={labelStyle}>Deliver To</div><div style={valueStyle}>{deliverTo || '—'}</div></td>
              </tr>
              <tr>
                <td style={cellStyle}><div style={labelStyle}>Trucking Company</div><div style={valueStyle}>{truckingCompany || '—'}</div></td>
                <td style={cellStyle}><div style={labelStyle}>Driver</div><div style={valueStyle}>{driverName || '—'}</div></td>
              </tr>
            </>
          ) : (
            <>
              <tr>
                <td style={cellStyle}><div style={labelStyle}>Warehouse Receipt</div><div style={{ ...valueStyle, fontFamily: "'Courier New', monospace", color: GREEN_ACCENT }}>{wr?.wr_number || '—'}</div></td>
                <td style={cellStyle}><div style={labelStyle}>AWB</div><div style={{ ...valueStyle, fontFamily: "'Courier New', monospace" }}>{order.awb_number || '—'}</div></td>
              </tr>
              <tr>
                <td style={cellStyle}><div style={labelStyle}>Cargo Description</div><div style={valueStyle}>{order.cargo_description || '—'}</div></td>
                <td style={cellStyle}><div style={labelStyle}>Reference</div><div style={valueStyle}>{order.reference || '—'}</div></td>
              </tr>
            </>
          )}
        </tbody>
      </table>

      {/* Cargo Delivered */}
      <div style={{ fontSize: '9px', fontWeight: 800, color: GREEN, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px', paddingBottom: '3px', borderBottom: `1.5px solid ${GREEN_BORDER}` }}>{isBreakdownBup ? 'Breakdown BUP — AWBs' : 'Cargo Delivered'}</div>
      {isBreakdownBup ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '14px', fontSize: '10px' }}>
          <thead>
            <tr>
              {['#', 'AWB Number', 'Declared Pcs', 'Gross Wt (kg)', 'Received Pcs', 'CHW (kg)'].map(h => (
                <th key={h} style={{ background: GREEN, color: '#fff', padding: '5px 7px', textAlign: 'left', fontWeight: 700, fontSize: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {breakdownAwbs.map((a, i) => (
              <tr key={i}>
                <td style={tdStyle}>{i + 1}</td>
                <td style={{ ...tdStyle, fontFamily: "'Courier New', monospace", fontWeight: 600 }}>{a.awb_number}</td>
                <td style={tdStyle}>{a.pieces}</td>
                <td style={tdStyle}>{a.weight_kg}</td>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{a.received_pieces ?? a.pieces}</td>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{a.received_weight_kg ?? a.weight_kg}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2} style={{ ...tdStyle, fontWeight: 700, background: GREEN_LIGHT, borderTop: '2px solid #d1d5db' }}>TOTAL</td>
              <td style={{ ...tdStyle, fontWeight: 700, background: GREEN_LIGHT, borderTop: '2px solid #d1d5db' }}>{breakdownAwbs.reduce((s, a) => s + a.pieces, 0)} pcs</td>
              <td style={{ ...tdStyle, fontWeight: 700, background: GREEN_LIGHT, borderTop: '2px solid #d1d5db' }}>{breakdownAwbs.reduce((s, a) => s + a.weight_kg, 0)} kg</td>
              <td style={{ ...tdStyle, fontWeight: 700, background: GREEN_LIGHT, borderTop: '2px solid #d1d5db' }}>{breakdownAwbs.reduce((s, a) => s + (a.received_pieces ?? a.pieces), 0)} pcs</td>
              <td style={{ ...tdStyle, fontWeight: 700, background: GREEN_LIGHT, borderTop: '2px solid #d1d5db' }}>{breakdownAwbs.reduce((s, a) => s + (a.received_weight_kg ?? a.weight_kg), 0)} kg</td>
            </tr>
          </tfoot>
        </table>
      ) : isTransportOnly && cargoLines.length > 0 ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '14px', fontSize: '10px' }}>
          <thead>
            <tr>
              {['#', 'AWB / Guía', 'Reference / PO', 'Pieces', 'Weight (kg)', 'Note'].map(h => (
                <th key={h} style={{ background: GREEN, color: '#fff', padding: '5px 7px', textAlign: 'left', fontWeight: 700, fontSize: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cargoLines.map((l, i) => (
              <tr key={i}>
                <td style={tdStyle}>{i + 1}</td>
                <td style={{ ...tdStyle, fontFamily: "'Courier New', monospace", fontWeight: 600 }}>{l.awb || '—'}</td>
                <td style={tdStyle}>{l.reference || '—'}</td>
                <td style={tdStyle}>{l.pieces}</td>
                <td style={tdStyle}>{l.weight_kg}</td>
                <td style={tdStyle}>{l.note || ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} style={{ ...tdStyle, fontWeight: 700, background: GREEN_LIGHT, borderTop: '2px solid #d1d5db' }}>TOTAL</td>
              <td style={{ ...tdStyle, fontWeight: 700, background: GREEN_LIGHT, borderTop: '2px solid #d1d5db' }}>{totalQty} pcs</td>
              <td style={{ ...tdStyle, fontWeight: 700, background: GREEN_LIGHT, borderTop: '2px solid #d1d5db' }}>{totalWeight} kg</td>
              <td style={{ ...tdStyle, background: GREEN_LIGHT, borderTop: '2px solid #d1d5db' }}></td>
            </tr>
          </tfoot>
        </table>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '14px', fontSize: '10px' }}>
          <thead>
            <tr>
              {['#', 'Type', 'Qty', 'L (cm)', 'W (cm)', 'H (cm)', 'CBM', 'Weight (kg)', 'Location'].map(h => (
                <th key={h} style={{ background: GREEN, color: '#fff', padding: '5px 7px', textAlign: 'left', fontWeight: 700, fontSize: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{h}</th>
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
            )) : (
              <tr>
                <td style={tdStyle}>1</td>
                <td style={tdStyle}>—</td>
                <td style={tdStyle}>{order.declared_pieces || '—'}</td>
                <td style={tdStyle} colSpan={4}></td>
                <td style={tdStyle}>{order.declared_weight || '—'}</td>
                <td style={tdStyle}></td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2} style={{ ...tdStyle, fontWeight: 700, background: GREEN_LIGHT, borderTop: '2px solid #d1d5db' }}>TOTAL</td>
              <td style={{ ...tdStyle, fontWeight: 700, background: GREEN_LIGHT, borderTop: '2px solid #d1d5db' }}>{totalQty || order.declared_pieces || ''}</td>
              <td colSpan={3} style={{ ...tdStyle, background: GREEN_LIGHT, borderTop: '2px solid #d1d5db' }}></td>
              <td style={{ ...tdStyle, fontWeight: 700, background: GREEN_LIGHT, borderTop: '2px solid #d1d5db' }}>{totalCbm ? totalCbm.toFixed(3) : ''}</td>
              <td style={{ ...tdStyle, fontWeight: 700, background: GREEN_LIGHT, borderTop: '2px solid #d1d5db' }}>{totalWeight || order.declared_weight || ''} kg</td>
              <td style={{ ...tdStyle, background: GREEN_LIGHT, borderTop: '2px solid #d1d5db' }}></td>
            </tr>
          </tfoot>
        </table>
      )}

      {/* Services Performed */}
      <div style={{ fontSize: '9px', fontWeight: 800, color: GREEN, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px', paddingBottom: '3px', borderBottom: `1.5px solid ${GREEN_BORDER}` }}>Services Performed</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '14px', fontSize: '10px' }}>
        <thead>
          <tr>
            {(isTransportOnly ? ['Service', 'Route', 'Completed'] : ['Service', 'Completed']).map(h => (
              <th key={h} style={{ background: '#f8fafc', padding: '5px 10px', textAlign: 'left', fontWeight: 700, fontSize: '8px', textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid #e5e7eb', color: '#6b7280' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {completedServices.map((s, i) => (
            <tr key={i}>
              <td style={{ ...tdStyle, fontWeight: 600 }}>{SERVICE_LABELS[s.type] || s.type}</td>
              {isTransportOnly && <td style={{ ...tdStyle, fontSize: '9px' }}>{pickupFrom} → {deliverTo}</td>}
              <td style={{ ...tdStyle, fontSize: '9px' }}>{s.completed_at ? new Date(s.completed_at).toLocaleString('es-CL') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* BUP details for transport-only */}
      {isTransportOnly && transportType === 'bup' && bupCount > 0 && (
        <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '6px', padding: '10px 14px', marginBottom: '14px' }}>
          <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
            <div>
              <div style={labelStyle}>Transport Type</div>
              <div style={{ ...valueStyle, fontSize: '12px' }}>BUP — {bupCount} unit{bupCount !== 1 ? 's' : ''}</div>
            </div>
            {uldNumbers.length > 0 && (
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>ULD Numbers</div>
                <div style={{ ...valueStyle, fontFamily: "'Courier New', monospace", fontSize: '11px' }}>{uldNumbers.join(', ')}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Delivery Confirmation */}
      <div style={{ fontSize: '9px', fontWeight: 800, color: GREEN, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px', paddingBottom: '3px', borderBottom: `1.5px solid ${GREEN_BORDER}` }}>Delivery Confirmation</div>
      <div style={{ background: GREEN_LIGHT, border: `1px solid ${GREEN_BORDER}`, borderRadius: '6px', padding: '12px 14px', marginBottom: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '8px' }}>
          <div>
            <div style={labelStyle}>Received By</div>
            <div style={{ ...valueStyle, fontSize: '13px' }}>{order.pod_receiver || '—'}</div>
          </div>
          <div>
            <div style={labelStyle}>ID / License</div>
            <div style={{ ...valueStyle, fontFamily: "'Courier New', monospace" }}>{order.pod_receiver_id || '—'}</div>
          </div>
          <div>
            <div style={labelStyle}>Date & Time</div>
            <div style={valueStyle}>{order.pod_at ? new Date(order.pod_at).toLocaleString('es-CL') : '—'}</div>
          </div>
          <div>
            <div style={labelStyle}>{isTransportOnly ? 'Driver' : 'MCL Agent'}</div>
            <div style={valueStyle}>{isTransportOnly ? (driverName || '—') : (order.pod_by ? order.pod_by.split('@')[0] : '—')}</div>
          </div>
        </div>
        {order.pod_notes && (
          <div style={{ marginTop: '8px' }}>
            <div style={labelStyle}>Notes</div>
            <div style={{ fontSize: '11px', fontWeight: 400, fontStyle: 'italic', color: '#374151' }}>{order.pod_notes}</div>
          </div>
        )}
      </div>

      {/* Photo + Signatures */}
      <div style={{ display: 'flex', gap: '30px', alignItems: 'flex-end', marginTop: '20px' }}>
        {order.pod_photo_url && (
          <div>
            <div style={{ ...labelStyle, marginBottom: '6px' }}>Photo Evidence</div>
            <img src={order.pod_photo_url} alt="POD Photo" style={{ width: '120px', height: '90px', objectFit: 'cover', borderRadius: '6px', border: '1px solid #e5e7eb' }} />
          </div>
        )}
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: '40px' }}>
            <div style={{ flex: 1 }}>
              <div style={{ height: '50px' }}></div>
              <div style={{ borderTop: `1.5px solid ${GREEN}`, paddingTop: '5px' }}>
                <div style={{ fontSize: '9px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Delivered by{isTransportOnly ? ' (Driver)' : ' (MCL)'}</div>
                <div style={{ fontSize: '10px', color: '#374151', marginTop: '2px' }}>{isTransportOnly && driverName ? `Name: ${driverName}` : 'Name: ________________________'}</div>
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ height: '50px' }}></div>
              <div style={{ borderTop: `1.5px solid ${GREEN}`, paddingTop: '5px' }}>
                <div style={{ fontSize: '9px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Received by (Client)</div>
                <div style={{ fontSize: '10px', color: '#374151', marginTop: '2px' }}>{order.pod_receiver ? `Name: ${order.pod_receiver}` : 'Name: ________________________'}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ position: 'absolute', bottom: '30px', left: '48px', right: '48px', textAlign: 'center', fontSize: '8px', color: '#9ca3af', borderTop: `1px solid ${GREEN_BORDER}`, paddingTop: '6px' }}>
        MinCurl Logistics LLC &bull; 2323 NW 82nd Ave, Doral, FL 33122 &bull; info@mincurllogistics.com &bull; +1 (786) 534-5440<br />
        This document certifies the delivery of the cargo described above.
      </div>
    </div>
  )

  return (
    <Layout title={`${isTransportOnly ? 'POD' : 'POS'} — ${order.so_number}`} backTo={`/warehouse-services/orders/${order.id}`}>
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

// ── Inline styles ──
const cellStyle: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb' }
const labelStyle: React.CSSProperties = { fontSize: '8px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '1px' }
const valueStyle: React.CSSProperties = { fontSize: '11px', fontWeight: 600, color: '#1f2937' }
const tdStyle: React.CSSProperties = { padding: '5px 7px', borderBottom: '1px solid #e5e7eb', color: '#374151' }
