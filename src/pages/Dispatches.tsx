import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'
import { db } from '../lib/firebase'
import { collection, query, orderBy, getDocs, getDoc, doc, updateDoc, deleteDoc, addDoc, where, limit } from 'firebase/firestore'
import { Dispatch, ReturnEvent, InventoryDocument, Client } from '../types'
import { useAuth } from '../contexts/AuthContext'
import { fmtNum } from '../lib/utils'
import { WR_EMAIL_RECIPIENTS, MCL_CC_RECIPIENTS } from '../data/emailRecipients'

function formatDateTime(iso?: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

function toDateStr(d: Date) {
  return d.toISOString().slice(0, 10)
}


export default function Dispatches() {
  const { user, isClient, isAdmin, isSuperAgent, clientId: authClientId } = useAuth()
  const canCorrect = isAdmin || isSuperAgent

  const [dispatches, setDispatches] = useState<Dispatch[]>([])
  const [loading, setLoading]       = useState(true)
  // Map po_number → schedule string (from inventory_documents)
  const [scheduleByPO, setScheduleByPO] = useState<Record<string, string>>({})

  // Filters — default last 2 weeks
  const twoWeeksAgo = toDateStr(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000))
  const [filterDateFrom, setFilterDateFrom] = useState(twoWeeksAgo)
  const [filterDateTo,   setFilterDateTo]   = useState('')
  const [filterClient,   setFilterClient]   = useState('')
  const [filterSearch,   setFilterSearch]   = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      let q
      if (isClient && authClientId) {
        // Use array-contains to filter dispatches that include this client
        q = query(collection(db, 'dispatches'), where('client_ids', 'array-contains', authClientId), orderBy('created_at', 'desc'), limit(500))
      } else {
        q = query(collection(db, 'dispatches'), orderBy('created_at', 'desc'), limit(500))
      }
      const snap = await getDocs(q)
      const disps = snap.docs.map(d => ({ id: d.id, ...d.data() })) as Dispatch[]
      setDispatches(disps)

      // Load schedule from inventory_documents for all WR IDs
      const allWrIds = [...new Set(disps.flatMap(d => d.wr_ids || []))]
      if (allWrIds.length > 0) {
        try {
          const batches: string[][] = []
          for (let i = 0; i < allWrIds.length; i += 30) {
            batches.push(allWrIds.slice(i, i + 30))
          }
          const poMap: Record<string, string> = {}
          await Promise.all(batches.map(async batch => {
            const constraints = [
              where('wr_id', 'in', batch),
              ...(isClient && authClientId ? [where('client_id', '==', authClientId)] : []),
            ]
            const invSnap = await getDocs(query(
              collection(db, 'inventory_documents'),
              ...constraints
            ))
            invSnap.docs.forEach(d => {
              const data = d.data() as InventoryDocument
              if (data.schedule && data.po_number) {
                poMap[data.po_number] = data.schedule
              }
            })
          }))
          setScheduleByPO(poMap)
        } catch (e) { console.warn('schedule load error', e) }
      }
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  // Derived filter options
  const clientOptions = [...new Set(
    dispatches.flatMap(d => d.client_names || []).filter(Boolean)
  )].sort()

  const filtered = dispatches.filter(d => {
    const dateRef = d.created_at?.slice(0, 10) ?? ''
    if (filterDateFrom && dateRef < filterDateFrom) return false
    if (filterDateTo   && dateRef > filterDateTo)   return false
    if (filterClient && !(d.client_names || []).includes(filterClient)) return false
    if (filterSearch) {
      const s = filterSearch.toLowerCase()
      if (
        !d.booking_number?.toLowerCase().includes(s) &&
        !d.container_number?.toLowerCase().includes(s) &&
        !(d.po_numbers || []).some(p => p.toLowerCase().includes(s))
      ) return false
    }
    return true
  })

  const hasFilters = filterDateFrom !== twoWeeksAgo || filterDateTo || filterClient || filterSearch
  const selectClass = 'border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/30 bg-white'

  return (
    <Layout title="Consolidados" backTo="/sea">
      {!isClient && (
        <div className="flex justify-end mb-4">
          <Link
            to="/dispatches/new"
            className="flex items-center gap-2 bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-800 transition-colors"
          >
            <span className="text-lg leading-none font-bold">+</span>
            Nueva Consolidación
          </Link>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <input
            type="text"
            placeholder="Buscar booking, contenedor, PO..."
            value={filterSearch}
            onChange={e => setFilterSearch(e.target.value)}
            className={selectClass + ' w-full'}
          />
          {clientOptions.length > 0 && (
            <select value={filterClient} onChange={e => setFilterClient(e.target.value)} className={selectClass}>
              <option value="">Todos los clientes</option>
              {clientOptions.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 whitespace-nowrap">Desde</label>
            <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} className={selectClass + ' flex-1'} />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 whitespace-nowrap">Hasta</label>
            <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} className={selectClass + ' flex-1'} />
          </div>
        </div>
        {hasFilters && (
          <button
            onClick={() => { setFilterDateFrom(twoWeeksAgo); setFilterDateTo(''); setFilterClient(''); setFilterSearch('') }}
            className="mt-2 text-xs text-gray-400 hover:text-gray-600 underline"
          >
            Restablecer filtros
          </button>
        )}
      </div>

      {loading ? (
        <div className="p-8 text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue mx-auto" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center text-gray-400">
          {dispatches.length === 0 ? 'No hay consolidados registrados aún.' : 'Sin resultados para los filtros aplicados.'}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(d => (
            <DispatchCard
              key={d.id}
              dispatch={d}
              isAdmin={isAdmin}
              isSuperAgent={isSuperAgent}
              isClient={isClient}
              canCorrect={canCorrect}
              scheduleByPO={scheduleByPO}
              onDelete={id => setDispatches(prev => prev.filter(x => x.id !== id))}
              onUpdate={updated => setDispatches(prev => prev.map(x => x.id === updated.id ? updated : x))}
            />
          ))}
        </div>
      )}
    </Layout>
  )
}

function DispatchCard({ dispatch: d, isAdmin, isSuperAgent, isClient, canCorrect, scheduleByPO, onDelete, onUpdate }: { dispatch: Dispatch; isAdmin: boolean; isSuperAgent: boolean; isClient: boolean; canCorrect: boolean; scheduleByPO: Record<string, string>; onDelete: (id: string) => void; onUpdate: (updated: Dispatch) => void }) {
  const isGateOut = d.status === 'gate_out'
  const { user, gmailToken, refreshGmailToken } = useAuth()
  const [sending,  setSending]  = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showReturn, setShowReturn] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const [returnReason, setReturnReason] = useState('')
  const [returnWaiting, setReturnWaiting] = useState(false)
  const [returnWeekend, setReturnWeekend] = useState(false)
  const [returnPortToWh, setReturnPortToWh] = useState(175)
  const [returnWhToPort, setReturnWhToPort] = useState(250)
  const [returnWaitingAmt, setReturnWaitingAmt] = useState(75)
  const [returnWeekendAmt, setReturnWeekendAmt] = useState(200)
  const [savingReturn, setSavingReturn] = useState(false)

  async function handleReturn() {
    if (!confirm('¿Confirmar que el contenedor fue devuelto y no fue recibido por la naviera?')) return
    setSavingReturn(true)
    try {
      const waitingCharge = returnWaiting ? returnWaitingAmt : null
      const weekendCharge = returnWeekend ? returnWeekendAmt : null
      const total = returnPortToWh + returnWhToPort + (waitingCharge || 0) + (weekendCharge || 0)

      const evt: ReturnEvent = {
        returned_at: new Date().toISOString(),
        returned_by: user?.email || user?.uid || '',
        reason: returnReason || null,
        port_to_warehouse: returnPortToWh,
        warehouse_to_port: returnWhToPort,
        waiting_time: waitingCharge,
        weekend_fee: weekendCharge,
        total,
      }

      const prevEvents = d.return_events || []
      await updateDoc(doc(db, 'dispatches', d.id!), {
        status: 'booked',
        return_events: [...prevEvents, evt],
      })

      // WRs back to reserved
      if (d.wr_ids?.length) {
        await Promise.allSettled(d.wr_ids.map(wrId =>
          updateDoc(doc(db, 'warehouse_receipts', wrId), { dispatch_status: 'reserved' })
        ))
      }

      // Create billing charges for the return
      const clientName = d.client_names?.[0] || '—'
      const charges = [
        { name: 'Drayage Return — Puerto a Bodega', amount: returnPortToWh },
        { name: 'Drayage Return — Bodega a Puerto', amount: returnWhToPort },
        ...(waitingCharge ? [{ name: 'Drayage Return — Waiting Time', amount: waitingCharge }] : []),
        ...(weekendCharge ? [{ name: 'Drayage Return — Weekend Fee', amount: weekendCharge }] : []),
      ]
      for (const ch of charges) {
        await addDoc(collection(db, 'billing_charges'), {
          charge_name: ch.name,
          unit: 'per_container',
          qty: 1,
          unit_price: ch.amount,
          total: ch.amount,
          currency: 'USD',
          billing_event: 'dispatch',
          dispatch_id: d.id,
          wr_id: null,
          wr_number: null,
          po_number: d.po_numbers?.join(', ') || '',
          client_id: null,
          client_name: clientName,
          cargo_type: 'LOC',
          status: 'pending',
          created_at: evt.returned_at,
        })
      }

      onUpdate({ ...d, status: 'booked', return_events: [...prevEvents, evt] })
      setShowReturn(false)
    } catch (e) {
      alert('Error: ' + (e instanceof Error ? e.message : String(e)))
    }
    setSavingReturn(false)
  }

  async function handleDelete() {
    if (!confirm(`¿Eliminar consolidado Booking ${d.booking_number || d.id}?`)) return
    setDeleting(true)
    try {
      // Free up ALL WRs regardless of dispatch status — return them to warehouse inventory
      if (d.wr_ids?.length) {
        await Promise.allSettled(d.wr_ids.map(wrId =>
          updateDoc(doc(db, 'warehouse_receipts', wrId), {
            dispatch_status: null,
            container_number: null,
            dispatched_at: null,
            dispatch_booking_number: null,
            dispatch_seal_number: null,
            dispatch_driver_name: null,
          })
        ))
      }
      await deleteDoc(doc(db, 'dispatches', d.id!))
      onDelete(d.id!)
    } catch (e) {
      alert('Error al eliminar: ' + (e instanceof Error ? e.message : String(e)))
    }
    setDeleting(false)
  }

  function buildMime(to: string, ccOverride?: { name: string; email: string }[]): string {
    const boundary = 'MCL_DSP_' + Date.now()
    const naviera   = d.naviera === 'Otra' ? (d.naviera_other || 'Otra') : d.naviera
    const body = [
      `Estimados,`,
      ``,
      `Confirmamos el consolidado de carga con los siguientes datos:`,
      ``,
      `── CONTENEDOR ──────────────────────────────`,
      `Booking # Naviera:  ${d.booking_number || '—'}`,
      ...(d.booking_request_li ? [`Booking Request LI: ${d.booking_request_li}`] : []),
      `Contenedor:         ${d.container_number || '—'} · ${d.container_size}'`,
      `Naviera:            ${naviera}`,
      `Transporte:         ${d.transport_company || '—'}`,
      `Destino(s):         ${d.destinations?.join(', ') || '—'}`,
      `Fecha Programada:   ${formatDateTime(d.scheduled_at)}`,
      `Fecha Gate Out:     ${formatDateTime(d.gate_out_at)}`,
      `Sello:              ${d.seal_number || '—'}`,
      ``,
      `── DRIVER ──────────────────────────────────`,
      `Nombre:             ${d.gate_driver_name || '—'}`,
      `Licencia #:         ${d.gate_driver_license || '—'}`,
      ``,
      `── CARGA DESPACHADA ────────────────────────`,
      `POs:                ${d.po_numbers?.join(', ') || '—'}`,
      `WRs:                ${d.wr_numbers?.join(', ') || '—'}`,
      `Total Piezas:       ${fmtNum(d.total_qty)}`,
      `Total CBM:          ${fmtNum(d.total_cbm, 4)}`,
      `Total KG:           ${fmtNum(d.total_kg, 1)}`,
      ``,
      `Muchas gracias,`,
      `MinCurl Logistics`,
    ].join('\n')

    const cc = (ccOverride || MCL_CC_RECIPIENTS).map(r => r.email).join(', ')
    const parts: string[] = [
      `MIME-Version: 1.0`,
      `To: ${to}`,
      `Cc: ${cc}`,
      `Subject: Confirmacion Consolidado Booking ${d.booking_number || '—'}`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=UTF-8`,
      ``,
      body,
      ``,
    ]

    function addPhoto(dataUrl: string, filename: string) {
      const [header, b64] = dataUrl.split(',')
      const mime = header.match(/:(.*?);/)?.[1] || 'image/jpeg'
      parts.push(
        `--${boundary}`,
        `Content-Type: ${mime}`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${filename}"`,
        ``,
        b64,
        ``,
      )
    }

    if (d.seal_photo_url)        addPhoto(d.seal_photo_url,        `sello_${d.booking_number}.jpg`)
    if (d.container_photo_url)   addPhoto(d.container_photo_url,   `contenedor_${d.container_number || d.booking_number}.jpg`)
    if (d.gate_driver_photo_url) addPhoto(d.gate_driver_photo_url, `licencia_chofer_${d.booking_number}.jpg`)

    parts.push(`--${boundary}--`)
    return parts.join('\r\n')
  }

  async function createGmailDraft(token: string, rawMime: string): Promise<string> {
    const encoded = btoa(unescape(encodeURIComponent(rawMime)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { raw: encoded } }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err?.error?.message || 'Gmail API error')
    }
    const data = await res.json()
    return data.id
  }

  async function handleSendEmail() {
    setSending(true)
    try {
      let token = gmailToken
      if (!token) {
        token = await refreshGmailToken()
        if (!token) throw new Error('No se pudo obtener autorización de Gmail.')
      }

      // Resolve recipients from clients
      let recipients: { name: string; email: string }[] = []
      const clientNames = d.client_names || []
      const destinations = d.destinations || []
      if (clientNames.length > 0) {
        for (const cn of clientNames) {
          const clSnap = await getDocs(query(collection(db, 'clients'), where('name', '==', cn)))
          for (const clDoc of clSnap.docs) {
            const client = clDoc.data() as Client
            for (const r of client.email_recipients || []) {
              if (!r.notify_gate_out || !r.email) continue
              if (r.destination && destinations.length > 0 && !destinations.includes(r.destination)) continue
              recipients.push({ name: r.name, email: r.email })
            }
          }
        }
        // Deduplicate by email
        const seen = new Set<string>()
        recipients = recipients.filter(r => { if (seen.has(r.email)) return false; seen.add(r.email); return true })
      }
      if (recipients.length === 0) recipients = WR_EMAIL_RECIPIENTS

      // Resolve CC from config
      let ccList = MCL_CC_RECIPIENTS
      const ccSnap = await getDoc(doc(db, 'config', 'email_settings'))
      if (ccSnap.exists() && ccSnap.data().mcl_cc_recipients?.length) {
        ccList = ccSnap.data().mcl_cc_recipients
      }

      const to   = recipients.map(r => r.email).join(', ')
      const mime = buildMime(to, ccList)
      let draftId: string
      try {
        draftId = await createGmailDraft(token, mime)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : ''
        if (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('expired') || msg.toLowerCase().includes('401')) {
          const fresh = await refreshGmailToken()
          if (!fresh) throw new Error('Sesión expirada. Recarga la página.')
          draftId = await createGmailDraft(fresh, mime)
        } else throw err
      }
      window.open(`https://mail.google.com/mail/u/0/#drafts?compose=${draftId}`, '_blank')
      alert(`Borrador creado. Se abrió Gmail para revisar y enviar.\nDestinatarios: ${recipients.map(r => r.name).join(', ')}`)
    } catch (err: unknown) {
      alert(`Error al enviar mail: ${err instanceof Error ? err.message : 'Error desconocido'}`)
    }
    setSending(false)
  }

  return (
    <div className={`bg-white rounded-xl shadow-sm border p-4 ${isGateOut ? 'border-green-200' : 'border-orange-200'}`}>
      <div className="flex items-start justify-between gap-3">
        {/* Left: main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-bold text-mcl-blue font-mono text-sm">{d.container_size === 'LCL' ? 'LCL' : (d.container_number || '—')}</span>
            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded">{d.container_size === 'LCL' ? 'LCL' : d.container_size + "'"}</span>
            <span className="text-xs text-gray-500">{d.naviera === 'Otra' ? d.naviera_other : d.naviera}</span>
            {d.destinations?.map(dest => (
              <span key={dest} className="text-xs bg-mcl-blue/10 text-mcl-blue font-bold px-2 py-0.5 rounded">{dest}</span>
            ))}
            {d.client_names?.map(cn => (
              <span key={cn} className="text-xs bg-teal-50 text-teal-700 px-2 py-0.5 rounded font-medium">{cn}</span>
            ))}
            {isGateOut ? (
              <span className="inline-flex items-center gap-1 bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full font-medium">✓ Gate Out</span>
            ) : (
              <span className="inline-flex items-center gap-1 bg-orange-100 text-orange-600 text-xs px-2 py-0.5 rounded-full font-medium">⏳ Reservado</span>
            )}
            <span className="font-bold text-gray-800 font-mono text-base ml-auto">Booking: {d.booking_number || '—'}</span>
          </div>

          <div className="text-xs text-gray-500 mb-2">
            {d.booking_request_li && <>Booking Request LI: <span className="font-semibold text-gray-700">{d.booking_request_li}</span> · </>}
            Transporte: <span className="text-gray-700">{d.transport_company || '—'}</span>
          </div>

          <div className="flex flex-wrap gap-1 mb-2">
            {d.po_numbers?.map(po => {
              const schedule = scheduleByPO[po] || ''
              return (
                <span key={po} className="bg-mcl-blue/10 text-mcl-blue text-xs font-mono font-semibold px-2 py-0.5 rounded">
                  {po}{schedule ? <span className="text-gray-500 font-normal ml-1">Sch: {schedule}</span> : ''}
                </span>
              )
            })}
          </div>

          <div className="text-xs text-gray-400">
            {d.wr_numbers?.length > 0 && <>WR: {d.wr_numbers.join(', ')} · </>}
            Programado: {formatDateTime(d.scheduled_at)}
            {isGateOut && d.gate_out_at && <> · Gate Out: {formatDateTime(d.gate_out_at)}</>}
          </div>

          {isGateOut && (
            <div className="mt-1 text-xs text-gray-500">
              Sello: <span className="font-semibold">{d.seal_number || '—'}</span>
              {d.gate_driver_name && <> · Chofer: {d.gate_driver_name}</>}
            </div>
          )}
        </div>

        {/* Right: actions */}
        {isClient && (
          <div className="flex flex-col gap-2 flex-shrink-0">
            <button
              onClick={() => setShowDetail(prev => !prev)}
              className="flex items-center gap-1.5 border border-gray-200 text-gray-600 text-xs font-semibold px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors whitespace-nowrap text-center"
            >
              {showDetail ? 'Ocultar' : 'Ver Detalle'}
            </button>
          </div>
        )}
        {!isClient && (
        <div className="flex-shrink-0">
          {!isGateOut && (
            <div className="grid grid-cols-2 gap-2">
              <Link
                to={`/dispatches/${d.id}/confirm`}
                className="bg-orange-500 text-white text-xs font-semibold px-3 py-2 rounded-lg hover:bg-orange-600 transition-colors whitespace-nowrap text-center"
              >
                Gate Out
              </Link>
              <Link
                to={`/dispatches/${d.id}/edit`}
                className="flex items-center justify-center gap-1.5 border border-gray-200 text-gray-600 text-xs font-semibold px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors whitespace-nowrap"
              >
                Editar
              </Link>
              {(isAdmin || isSuperAgent) && (
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="col-span-2 text-xs text-red-400 hover:text-red-600 border border-red-100 px-3 py-1.5 rounded-lg disabled:opacity-40 transition-colors text-center"
                >
                  {deleting ? 'Eliminando...' : 'Eliminar'}
                </button>
              )}
            </div>
          )}
          {isGateOut && (
            <div className="grid grid-cols-2 gap-2">
              <Link
                to={`/dispatches/${d.id}/edit`}
                className="flex items-center justify-center gap-1.5 border border-gray-200 text-gray-600 text-xs font-semibold px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors whitespace-nowrap text-center"
              >
                Ver
              </Link>
              {canCorrect && (
                <Link
                  to={`/dispatches/${d.id}/correct`}
                  className="flex items-center justify-center gap-1.5 border border-amber-300 bg-amber-50 text-amber-700 text-xs font-semibold px-3 py-2 rounded-lg hover:bg-amber-100 transition-colors whitespace-nowrap text-center"
                >
                  Corregir
                </Link>
              )}
              <button
                onClick={handleSendEmail}
                disabled={sending}
                title="Enviar email de consolidado"
                className="flex items-center justify-center gap-1.5 bg-green-600 text-white text-xs font-semibold px-3 py-2 rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 whitespace-nowrap"
              >
                {sending ? (
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                )}
                Mail
              </button>
              <button
                onClick={() => setShowReturn(true)}
                className="flex items-center justify-center gap-1.5 bg-red-500 text-white text-xs font-semibold px-3 py-2 rounded-lg hover:bg-red-600 transition-colors whitespace-nowrap"
              >
                Returned
              </button>
              {(isAdmin || isSuperAgent) && (
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="col-span-2 text-xs text-red-400 hover:text-red-600 border border-red-100 px-3 py-1.5 rounded-lg disabled:opacity-40 transition-colors text-center"
                >
                  {deleting ? 'Eliminando...' : 'Eliminar'}
                </button>
              )}
            </div>
          )}
        </div>
        )}
      </div>

      {/* Return history */}
      {(d.return_events || []).length > 0 && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <p className="text-[10px] text-red-400 font-semibold uppercase mb-1">Devoluciones ({d.return_events!.length})</p>
          {d.return_events!.map((evt, i) => (
            <div key={i} className="text-xs text-gray-500 flex flex-wrap gap-x-3 gap-y-0.5">
              <span>{formatDateTime(evt.returned_at)}</span>
              <span>Puerto→Bodega</span>
              <span>Bodega→Puerto</span>
              {evt.waiting_time && <span>Waiting</span>}
              {evt.weekend_fee && <span>Weekend</span>}
              {evt.reason && <span className="italic">({evt.reason})</span>}
            </div>
          ))}
        </div>
      )}

      {/* Client detail panel */}
      {showDetail && (
        <div className="mt-3 pt-3 border-t border-gray-200 space-y-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
            <div>
              <span className="text-gray-400 uppercase font-semibold text-[10px]">Contenedor</span>
              <p className="text-gray-800 font-medium">{d.container_number || '—'} · {d.container_size}'</p>
            </div>
            <div>
              <span className="text-gray-400 uppercase font-semibold text-[10px]">Booking #</span>
              <p className="text-gray-800 font-medium">{d.booking_number || '—'}</p>
            </div>
            <div>
              <span className="text-gray-400 uppercase font-semibold text-[10px]">Naviera</span>
              <p className="text-gray-800">{d.naviera === 'Otra' ? d.naviera_other : d.naviera}</p>
            </div>
            <div>
              <span className="text-gray-400 uppercase font-semibold text-[10px]">Transporte</span>
              <p className="text-gray-800">{d.transport_company || '—'}</p>
            </div>
            <div>
              <span className="text-gray-400 uppercase font-semibold text-[10px]">Destino(s)</span>
              <p className="text-gray-800">{d.destinations?.join(', ') || '—'}</p>
            </div>
            <div>
              <span className="text-gray-400 uppercase font-semibold text-[10px]">Sello</span>
              <p className="text-gray-800 font-medium">{d.seal_number || '—'}</p>
            </div>
            <div>
              <span className="text-gray-400 uppercase font-semibold text-[10px]">Fecha Programada</span>
              <p className="text-gray-800">{formatDateTime(d.scheduled_at)}</p>
            </div>
            <div>
              <span className="text-gray-400 uppercase font-semibold text-[10px]">Gate Out</span>
              <p className="text-gray-800">{d.gate_out_at ? formatDateTime(d.gate_out_at) : '—'}</p>
            </div>
          </div>

          {/* Driver info */}
          {(d.gate_driver_name || d.gate_driver_license) && (
            <div className="pt-2 border-t border-gray-100">
              <span className="text-gray-400 uppercase font-semibold text-[10px] block mb-1">Driver</span>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                <div>
                  <span className="text-gray-400">Nombre:</span>{' '}
                  <span className="text-gray-800 font-medium">{d.gate_driver_name || '—'}</span>
                </div>
                <div>
                  <span className="text-gray-400">Licencia #:</span>{' '}
                  <span className="text-gray-800 font-medium">{d.gate_driver_license || '—'}</span>
                </div>
              </div>
            </div>
          )}

          {/* POs & WRs */}
          <div className="pt-2 border-t border-gray-100">
            <span className="text-gray-400 uppercase font-semibold text-[10px] block mb-1">Carga Despachada</span>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              <div>
                <span className="text-gray-400">POs:</span>{' '}
                <span className="text-gray-800 font-medium">{d.po_numbers?.join(', ') || '—'}</span>
              </div>
              <div>
                <span className="text-gray-400">WRs:</span>{' '}
                <span className="text-gray-800 font-medium">{d.wr_numbers?.join(', ') || '—'}</span>
              </div>
            </div>
          </div>

          {/* Totals */}
          <div className="pt-2 border-t border-gray-100 flex gap-6 text-xs">
            <div>
              <span className="text-gray-400 uppercase font-semibold text-[10px]">Piezas</span>
              <p className="text-gray-800 font-bold">{fmtNum(d.total_qty)}</p>
            </div>
            <div>
              <span className="text-gray-400 uppercase font-semibold text-[10px]">CBM</span>
              <p className="text-gray-800 font-bold">{fmtNum(d.total_cbm, 4)}</p>
            </div>
            <div>
              <span className="text-gray-400 uppercase font-semibold text-[10px]">KG</span>
              <p className="text-gray-800 font-bold">{fmtNum(d.total_kg, 1)}</p>
            </div>
          </div>

          {/* Photos */}
          {(d.seal_photo_url || d.container_photo_url || d.gate_driver_photo_url) && (
            <div className="pt-2 border-t border-gray-100">
              <span className="text-gray-400 uppercase font-semibold text-[10px] block mb-2">Fotos</span>
              <div className="flex gap-3 flex-wrap">
                {d.seal_photo_url && (
                  <div className="text-center">
                    <img src={d.seal_photo_url} alt="Sello" className="w-28 h-28 object-cover rounded-lg border border-gray-200" />
                    <span className="text-[10px] text-gray-400 mt-1 block">Sello</span>
                  </div>
                )}
                {d.container_photo_url && (
                  <div className="text-center">
                    <img src={d.container_photo_url} alt="Contenedor" className="w-28 h-28 object-cover rounded-lg border border-gray-200" />
                    <span className="text-[10px] text-gray-400 mt-1 block">Contenedor</span>
                  </div>
                )}
                {d.gate_driver_photo_url && (
                  <div className="text-center">
                    <img src={d.gate_driver_photo_url} alt="Licencia" className="w-28 h-28 object-cover rounded-lg border border-gray-200" />
                    <span className="text-[10px] text-gray-400 mt-1 block">Licencia</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Return modal */}
      {showReturn && (
        <>
          <div className="fixed inset-0 bg-black/40 z-50" onClick={() => setShowReturn(false)} />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[90vw] max-w-md bg-white rounded-2xl shadow-2xl z-50 p-5">
            <h3 className="font-bold text-gray-800 mb-4">Container Returned</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500">Motivo (opcional)</label>
                <input type="text" value={returnReason} onChange={e => setReturnReason(e.target.value)}
                  placeholder="Naviera no recibio..."
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
              </div>

              <p className="text-xs text-gray-400 font-semibold uppercase pt-1">Cargos Drayage</p>

              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700">Puerto → Bodega</span>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-gray-400">$</span>
                  <input type="number" value={returnPortToWh} onChange={e => setReturnPortToWh(Number(e.target.value))}
                    className="w-20 border border-gray-200 rounded px-2 py-1 text-sm text-right" />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700">Bodega → Puerto</span>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-gray-400">$</span>
                  <input type="number" value={returnWhToPort} onChange={e => setReturnWhToPort(Number(e.target.value))}
                    className="w-20 border border-gray-200 rounded px-2 py-1 text-sm text-right" />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={returnWaiting} onChange={e => setReturnWaiting(e.target.checked)}
                    className="rounded border-gray-300" />
                  <span className="text-sm text-gray-700">Waiting Time</span>
                </div>
                {returnWaiting && (
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-gray-400">$</span>
                    <input type="number" value={returnWaitingAmt} onChange={e => setReturnWaitingAmt(Number(e.target.value))}
                      className="w-20 border border-gray-200 rounded px-2 py-1 text-sm text-right" />
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={returnWeekend} onChange={e => setReturnWeekend(e.target.checked)}
                    className="rounded border-gray-300" />
                  <span className="text-sm text-gray-700">Weekend Fee</span>
                </div>
                {returnWeekend && (
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-gray-400">$</span>
                    <input type="number" value={returnWeekendAmt} onChange={e => setReturnWeekendAmt(Number(e.target.value))}
                      className="w-20 border border-gray-200 rounded px-2 py-1 text-sm text-right" />
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-gray-200">
                <span className="text-sm font-bold text-gray-800">Total</span>
                <span className="text-sm font-bold text-red-600">
                  ${returnPortToWh + returnWhToPort + (returnWaiting ? returnWaitingAmt : 0) + (returnWeekend ? returnWeekendAmt : 0)}
                </span>
              </div>

              <div className="flex gap-2 pt-2">
                <button onClick={handleReturn} disabled={savingReturn}
                  className="flex-1 py-2.5 bg-red-600 text-white text-sm font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50">
                  {savingReturn ? 'Guardando...' : 'Confirmar Retorno'}
                </button>
                <button onClick={() => setShowReturn(false)}
                  className="px-4 py-2.5 bg-gray-100 text-gray-600 text-sm rounded-lg hover:bg-gray-200">
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
