import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { collection, query, where, getDocs, deleteDoc, doc, getDoc, updateDoc } from 'firebase/firestore'
import { db, auth } from '../../lib/firebase'
import Layout from '../../components/Layout'
import { generateDriverPin, createDeliveryTracking } from '../../lib/driverTracking'
import { buildAvDoHtml, openAvDoPrint } from '../../lib/avDeliveryOrderPdf'
import { buildAvTransferHtml, openAvTransferPrint } from '../../lib/avTransferCustodyPdf'
import type { AvDeliveryOrder, AvFlightAwb, AvPalletTag, DeliveryTracking } from '../../types'
import { logAvEvent } from '../../lib/avLog'
import { useAvCan } from '../../lib/avPermissions'

type DoWithId = AvDeliveryOrder & { id: string }
type PtWithId = AvPalletTag & { id: string }

const DEFAULT_TRUCKING = ['CO-Transportation', 'GEO Transport']

export default function AvDeliveryOrders() {
  const { id: flightId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { canAv } = useAvCan()
  const [dos, setDos] = useState<DoWithId[]>([])
  const [allPalletTags, setAllPalletTags] = useState<PtWithId[]>([])
  const [flightAwbs, setFlightAwbs] = useState<(AvFlightAwb & { id: string })[]>([])
  const [flightDestination, setFlightDestination] = useState('')
  const [trackingMap, setTrackingMap] = useState<Record<string, DeliveryTracking>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [vendorOptions, setVendorOptions] = useState<{ id: string; name: string }[]>([])

  // Modal state
  const [modalDo, setModalDo] = useState<DoWithId | null>(null)
  const [modalMode, setModalMode] = useState<'dispatch' | 'edit'>('dispatch')
  const [truckingCompany, setTruckingCompany] = useState('')
  const [customTrucking, setCustomTrucking] = useState('')
  const [driverName, setDriverName] = useState('')
  const [custodyMethod, setCustodyMethod] = useState<'seal' | 'escort' | 'locked_vehicle'>('seal')
  const [sealNumber, setSealNumber] = useState('')
  const [saving, setSaving] = useState(false)

  // ULD editing in modal
  const [editUlds, setEditUlds] = useState<string[]>([])
  const [uldInput, setUldInput] = useState('')
  const [uldError, setUldError] = useState('')
  const uldInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (flightId) {
      Promise.all([loadDos(flightId), loadPalletTags(flightId), loadFlightData(flightId), loadVendors()])
    }
  }, [flightId])

  async function loadVendors() {
    try {
      const snap = await getDocs(query(collection(db, 'vendors'), where('status', '==', 'active')))
      setVendorOptions(snap.docs.map(d => ({ id: d.id, name: (d.data() as any).name })))
    } catch { /* ignore */ }
  }

  async function loadFlightData(fId: string) {
    const [fSnap, awbSnap] = await Promise.all([
      getDoc(doc(db, 'av_flights', fId)),
      getDocs(query(collection(db, 'av_flight_awbs'), where('flight_id', '==', fId))),
    ])
    if (fSnap.exists()) setFlightDestination(fSnap.data().destination || '')
    setFlightAwbs(awbSnap.docs.map(d => ({ id: d.id, ...d.data() } as AvFlightAwb & { id: string })).filter(a => a.status !== 'removed'))
  }

  async function loadPalletTags(fId: string) {
    const snap = await getDocs(query(collection(db, 'av_pallet_tags'), where('flight_id', '==', fId)))
    setAllPalletTags(snap.docs.map(d => ({ id: d.id, ...d.data() } as PtWithId)))
  }

  async function loadDos(fId: string) {
    setLoading(true)
    const doSnap = await getDocs(query(collection(db, 'av_delivery_orders'), where('flight_id', '==', fId)))
    const doList = doSnap.docs.map(d => ({ id: d.id, ...d.data() } as DoWithId))
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    setDos(doList)

    // Load all tracking in parallel
    const dosWithTracking = doList.filter(d => d.tracking_id)
    const map: Record<string, DeliveryTracking> = {}
    if (dosWithTracking.length > 0) {
      const results = await Promise.all(
        dosWithTracking.map(d =>
          getDocs(query(collection(db, 'delivery_tracking'), where('do_number', '==', d.do_number)))
            .then(snap => ({ doNum: d.do_number, data: snap.empty ? null : snap.docs[0].data() as DeliveryTracking }))
            .catch(() => ({ doNum: d.do_number, data: null }))
        )
      )
      for (const r of results) { if (r.data) map[r.doNum] = r.data }
    }
    setTrackingMap(map)
    setLoading(false)
  }

  async function handleDelete(doItem: DoWithId) {
    if (!confirm(`Eliminar ${doItem.do_number}?`)) return
    await deleteDoc(doc(db, 'av_delivery_orders', doItem.id))
    if (flightId) logAvEvent(flightId, (doItem.awb_numbers || []).join(', ') || '-', 'do_deleted', `DO: ${doItem.do_number} eliminada`, auth.currentUser?.email || '')
    setDos(prev => prev.filter(d => d.id !== doItem.id))
  }

  // ── Open modal ──
  function openModal(doItem: DoWithId, mode: 'dispatch' | 'edit') {
    setModalDo(doItem)
    setModalMode(mode)
    setEditUlds([...doItem.uld_numbers])
    setUldInput('')
    setUldError('')

    const tc = doItem.trucking_company || ''
    const isKnown = DEFAULT_TRUCKING.includes(tc) || vendorOptions.some(v => v.name === tc)
    if (mode === 'edit' && tc && !isKnown) {
      setTruckingCompany('__custom__')
      setCustomTrucking(tc)
    } else {
      setTruckingCompany(tc)
      setCustomTrucking('')
    }
    setDriverName(doItem.driver_name || '')
    setCustodyMethod(doItem.custody_method || 'seal')
    setSealNumber(doItem.seal_number || '')
  }

  // ── ULD add/remove in modal ──
  function handleAddUld() {
    const raw = uldInput.replace(/\s+/g, '').toUpperCase()
    if (!raw) return
    setUldError('')

    if (editUlds.some(u => u.replace(/\s+/g, '').toUpperCase() === raw)) {
      setUldError('ULD ya esta en esta DO'); return
    }

    const match = allPalletTags.find(pt => {
      const norm = pt.pallet_number.replace(/\s+/g, '').toUpperCase()
      return norm === raw || norm.endsWith(raw) || raw.endsWith(norm)
    })

    if (!match) { setUldError(`ULD "${raw}" no encontrado en este vuelo`); return }
    if (match.ai_status !== 'complete') { setUldError(`ULD "${match.pallet_number}" aun no procesado por AI`); return }

    // Check if already in editUlds by pallet_number
    if (editUlds.some(u => u === match.pallet_number)) {
      setUldError('ULD ya esta en esta DO'); return
    }

    setEditUlds(prev => [...prev, match.pallet_number])
    setUldInput('')
    uldInputRef.current?.focus()
  }

  function handleRemoveUld(uldNumber: string) {
    setEditUlds(prev => prev.filter(u => u !== uldNumber))
  }

  // Recalculate AWBs from current editUlds
  function getAwbsFromUlds(uldNumbers: string[]): string[] {
    const awbSet = new Set<string>()
    for (const uld of uldNumbers) {
      const pt = allPalletTags.find(p => p.pallet_number === uld)
      if (pt?.lines) {
        for (const line of pt.lines) {
          awbSet.add(line.awb_number)
        }
      }
    }
    return [...awbSet]
  }

  // ── Save edit ──
  async function handleEditSave() {
    if (!modalDo || !flightId) return
    if (editUlds.length === 0) { setUldError('Debe tener al menos 1 ULD'); return }

    const effectiveTrucking = truckingCompany === '__custom__' ? customTrucking : truckingCompany
    const awbs = getAwbsFromUlds(editUlds)

    setSaving(true)
    try {
      await updateDoc(doc(db, 'av_delivery_orders', modalDo.id), {
        uld_numbers: editUlds,
        awb_numbers: awbs,
        trucking_company: effectiveTrucking.trim(),
        driver_name: driverName.trim(),
        custody_method: custodyMethod,
        seal_number: custodyMethod === 'seal' ? sealNumber : '',
        updated_at: new Date().toISOString(),
      })
      logAvEvent(flightId, awbs.join(', ') || '-', 'do_edited', `DO: ${modalDo.do_number} — ULDs: ${editUlds.join(', ')}`, auth.currentUser?.email || '')
      setModalDo(null)
      loadDos(flightId)
    } catch (err: any) {
      alert('Error: ' + (err.message || err))
    } finally {
      setSaving(false)
    }
  }

  // ── Dispatch ──
  async function handleDispatch() {
    if (!modalDo || !flightId) return
    if (editUlds.length === 0) { setUldError('Debe tener al menos 1 ULD'); return }

    const effectiveTrucking = truckingCompany === '__custom__' ? customTrucking : truckingCompany
    if (!effectiveTrucking.trim()) { alert('Selecciona la empresa de trucking'); return }
    if (!driverName.trim()) { alert('Escribe el nombre del driver'); return }

    const awbs = getAwbsFromUlds(editUlds)

    setSaving(true)
    try {
      const pin = generateDriverPin()

      await updateDoc(doc(db, 'av_delivery_orders', modalDo.id), {
        uld_numbers: editUlds,
        awb_numbers: awbs,
        trucking_company: effectiveTrucking,
        driver_name: driverName.trim(),
        custody_method: custodyMethod,
        seal_number: custodyMethod === 'seal' ? sealNumber : '',
        driver_pin: pin,
        status: 'dispatched',
        dispatched_at: new Date().toISOString(),
        dispatched_by: auth.currentUser?.email || '',
        updated_at: new Date().toISOString(),
      })

      const trackingId = await createDeliveryTracking({
        do_id: modalDo.id,
        do_number: modalDo.do_number,
        driver_pin: pin,
        driver_name: driverName.trim(),
        vendor_id: null,
        vendor_name: effectiveTrucking,
        driver_plate: null,
        driver_queue_id: null,
        airline: 'Avianca',
      })

      await updateDoc(doc(db, 'av_delivery_orders', modalDo.id), { tracking_id: trackingId })
      logAvEvent(flightId, awbs.join(', ') || '-', 'do_dispatched', `DO: ${modalDo.do_number} — Trucking: ${effectiveTrucking} — Driver: ${driverName.trim()}`, auth.currentUser?.email || '')

      setModalDo(null)
      loadDos(flightId)
    } catch (err: any) {
      alert('Error: ' + (err.message || err))
    } finally {
      setSaving(false)
    }
  }

  async function handleRevertToDraft(doItem: DoWithId) {
    if (!confirm(`Revertir ${doItem.do_number} a Draft? Se eliminara el PIN y tracking.`)) return
    try {
      await updateDoc(doc(db, 'av_delivery_orders', doItem.id), {
        status: 'draft',
        driver_pin: '',
        tracking_id: '',
        dispatched_at: '',
        dispatched_by: '',
        updated_at: new Date().toISOString(),
      })
      if (flightId) {
        logAvEvent(flightId, (doItem.awb_numbers || []).join(', ') || '-', 'do_reverted', `DO: ${doItem.do_number} revertida a Draft`, auth.currentUser?.email || '')
        loadDos(flightId)
      }
    } catch (err: any) {
      alert('Error: ' + (err.message || err))
    }
  }

  const filtered = dos.filter(d => {
    if (!search) return true
    const s = search.toLowerCase()
    return d.do_number.toLowerCase().includes(s) ||
      d.awb_numbers.some(a => a.toLowerCase().includes(s)) ||
      d.trucking_company.toLowerCase().includes(s) ||
      d.driver_name.toLowerCase().includes(s) ||
      d.uld_numbers.some(u => u.toLowerCase().includes(s))
  })

  function handlePrint(doItem: DoWithId) {
    const html = buildAvDoHtml({
      doData: doItem as any,
      awbs: flightAwbs,
      destination: flightDestination,
    })
    openAvDoPrint(html, doItem.do_number)
  }

  function handleTransferPrint(doItem: DoWithId) {
    const palletTags = allPalletTags
      .filter(pt => (doItem.uld_numbers || []).includes(pt.pallet_number))
      .flatMap(pt => (pt.lines || []).map(l => ({ uld_id: pt.pallet_number, awb_number: l.awb_number, pieces: l.pieces || 0 })))
    const html = buildAvTransferHtml({ doData: doItem as any, destination: flightDestination, palletTags })
    openAvTransferPrint(html, doItem.do_number)
  }

  function statusBadge(doItem: DoWithId) {
    if (doItem.status === 'draft') return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700">Draft</span>
    const tracking = trackingMap[doItem.do_number]
    if (!tracking) return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-700">Dispatched</span>
    switch (tracking.status) {
      case 'completed': return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-700">Completed</span>
      case 'in_progress': return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-700">In Progress</span>
      default: return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-700">Dispatched</span>
    }
  }

  if (loading) return <Layout title="Delivery Orders" backTo={`/avianca/flight/${flightId}`}><div className="flex justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div></Layout>

  return (
    <Layout title="Delivery Orders" backTo={`/avianca/flight/${flightId}`}>
      <div className="flex items-center justify-between mb-4">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar DO#, AWB, ULD, driver..."
          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 mr-3"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">{dos.length} DOs</span>
          {canAv('create_do') && (
            <button
              onClick={() => navigate(`/avianca/flight/${flightId}/do/new`)}
              className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-xs font-medium hover:bg-blue-900 whitespace-nowrap"
            >
              + Nueva DO
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center text-gray-400 py-12 text-sm">
          {dos.length === 0 ? 'No hay Delivery Orders para este vuelo.' : 'No se encontraron resultados.'}
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 uppercase text-[10px]">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">DO#</th>
                <th className="text-left px-3 py-2 font-semibold">Fecha</th>
                <th className="text-left px-3 py-2 font-semibold">ULDs</th>
                <th className="text-left px-3 py-2 font-semibold">AWBs</th>
                <th className="text-left px-3 py-2 font-semibold">Trucking</th>
                <th className="text-left px-3 py-2 font-semibold">Custody</th>
                <th className="text-center px-3 py-2 font-semibold">Status</th>
                <th className="text-center px-3 py-2 font-semibold">PIN</th>
                {canAv('edit_do') && <th className="text-center px-3 py-2 font-semibold w-32"></th>}
                <th className="text-center px-3 py-2 font-semibold w-10"></th>
                <th className="text-center px-3 py-2 font-semibold w-10"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(doItem => (
                <tr key={doItem.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono font-bold text-gray-800">{doItem.do_number}</td>
                  <td className="px-3 py-2 text-gray-500">{new Date(doItem.created_at).toLocaleDateString()}</td>
                  <td className="px-3 py-2 font-mono text-gray-600">{doItem.uld_numbers.join(', ')}</td>
                  <td className="px-3 py-2 font-mono text-gray-600">{doItem.awb_numbers.join(', ')}</td>
                  <td className="px-3 py-2 text-gray-600">{doItem.trucking_company || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2 text-gray-500 capitalize">{doItem.status === 'draft' && !doItem.custody_method ? <span className="text-gray-300">—</span> : <>{doItem.custody_method === 'locked_vehicle' ? 'Locked' : doItem.custody_method}{doItem.seal_number ? ` ${doItem.seal_number}` : ''}</>}</td>
                  <td className="px-3 py-2 text-center">{statusBadge(doItem)}</td>
                  <td className="px-3 py-2 text-center font-mono font-bold text-mcl-blue">{(doItem as any).driver_pin || <span className="text-gray-300">—</span>}</td>
                  {canAv('edit_do') && (
                    <td className="px-3 py-2 text-center">
                      <div className="flex items-center justify-center gap-2">
                        <button onClick={() => openModal(doItem, 'edit')} className="text-mcl-blue hover:text-blue-800 text-[10px] font-bold">Editar</button>
                        {doItem.status === 'draft' && (
                          <button onClick={() => openModal(doItem, 'dispatch')} className="text-green-600 hover:text-green-800 text-[10px] font-bold">Despachar</button>
                        )}
                        {doItem.status === 'dispatched' && (
                          <button onClick={() => handleRevertToDraft(doItem)} className="text-amber-600 hover:text-amber-800 text-[10px] font-bold">Revertir</button>
                        )}
                        {canAv('delete_do') && doItem.status === 'draft' && (
                          <button onClick={() => handleDelete(doItem)} className="text-red-400 hover:text-red-600 text-[10px]">Eliminar</button>
                        )}
                      </div>
                    </td>
                  )}
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => doItem.status !== 'draft' && handlePrint(doItem)}
                      disabled={doItem.status === 'draft'}
                      className={`${doItem.status === 'draft' ? 'text-gray-300 cursor-not-allowed' : 'text-gray-700 hover:text-mcl-blue cursor-pointer'}`}
                      title={doItem.status === 'draft' ? 'Despachar para imprimir' : 'Imprimir DO'}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4H7v4a2 2 0 002 2zm0-16h6a2 2 0 012 2v2H7V5a2 2 0 012-2z"/></svg>
                    </button>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => doItem.status !== 'draft' && handleTransferPrint(doItem)}
                      disabled={doItem.status === 'draft'}
                      className={`flex items-center gap-0.5 ${doItem.status === 'draft' ? 'text-gray-300 cursor-not-allowed' : 'text-red-700 hover:text-red-500 cursor-pointer'}`}
                      title={doItem.status === 'draft' ? 'Despachar para imprimir' : 'Transferencia Avianca'}
                    >
                      <span className="text-[9px] font-black leading-none">T.AV</span>
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4H7v4a2 2 0 002 2zm0-16h6a2 2 0 012 2v2H7V5a2 2 0 012-2z"/></svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit / Dispatch Modal */}
      {modalDo && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setModalDo(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-800 text-lg">{modalMode === 'dispatch' ? 'Despachar' : 'Editar'} {modalDo.do_number}</h3>
            </div>
            <div className="px-6 py-5 space-y-4">

              {/* ULDs section — editable */}
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-2">ULDs ({editUlds.length})</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {editUlds.map(u => (
                    <span key={u} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-blue-50 text-blue-700 border border-blue-200">
                      {u}
                      <button onClick={() => handleRemoveUld(u)} className="text-blue-400 hover:text-red-500 ml-0.5">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
                      </button>
                    </span>
                  ))}
                  {editUlds.length === 0 && <span className="text-xs text-red-500">Sin ULDs</span>}
                </div>
                <div className="flex gap-2">
                  <input
                    ref={uldInputRef}
                    type="text"
                    value={uldInput}
                    onChange={e => { setUldInput(e.target.value.toUpperCase()); setUldError('') }}
                    onKeyDown={e => { if (e.key === 'Enter') handleAddUld() }}
                    placeholder="Agregar ULD..."
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  />
                  <button onClick={handleAddUld} disabled={!uldInput.trim()}
                    className="px-3 py-1.5 bg-mcl-blue text-white rounded-lg text-xs font-medium hover:bg-blue-900 disabled:opacity-50">
                    + Agregar
                  </button>
                </div>
                {uldError && <p className="mt-1 text-xs text-red-600">{uldError}</p>}
                <p className="mt-1 text-[10px] text-gray-400">{allPalletTags.filter(p => p.ai_status === 'complete').length} ULDs procesados disponibles en este vuelo</p>
              </div>

              {/* AWBs derived — read-only preview */}
              {editUlds.length > 0 && (
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">AWBs resultantes</label>
                  <div className="flex flex-wrap gap-1">
                    {getAwbsFromUlds(editUlds).map(awb => (
                      <span key={awb} className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-gray-100 text-gray-600">{awb}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Transport fields */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Trucking Company {modalMode === 'dispatch' ? '*' : ''}</label>
                  <select
                    value={truckingCompany}
                    onChange={e => setTruckingCompany(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  >
                    <option value="">Seleccionar...</option>
                    {DEFAULT_TRUCKING.filter(name => !vendorOptions.some(v => v.name === name)).map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                    {vendorOptions.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                    <option value="__custom__">Otro (escribir)</option>
                  </select>
                  {truckingCompany === '__custom__' && (
                    <input
                      value={customTrucking}
                      onChange={e => setCustomTrucking(e.target.value)}
                      placeholder="Nombre empresa"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1 focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                    />
                  )}
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Driver {modalMode === 'dispatch' ? '*' : ''}</label>
                  <input
                    value={driverName}
                    onChange={e => setDriverName(e.target.value)}
                    placeholder="Nombre del driver"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Chain of Custody</label>
                  <div className="flex items-center gap-4">
                    {(['seal', 'escort', 'locked_vehicle'] as const).map(m => (
                      <label key={m} className="flex items-center gap-1.5 cursor-pointer text-sm">
                        <input type="radio" checked={custodyMethod === m} onChange={() => setCustodyMethod(m)} className="text-mcl-blue" />
                        {m === 'locked_vehicle' ? 'Locked' : m.charAt(0).toUpperCase() + m.slice(1)}
                      </label>
                    ))}
                  </div>
                </div>
                {custodyMethod === 'seal' && (
                  <div>
                    <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Seal Number</label>
                    <input
                      value={sealNumber}
                      onChange={e => setSealNumber(e.target.value)}
                      placeholder="Numero de sello"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setModalDo(null)} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancelar</button>
              {modalMode === 'edit' ? (
                <button onClick={handleEditSave} disabled={saving}
                  className="bg-mcl-blue text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-900 disabled:opacity-50">
                  {saving ? 'Guardando...' : 'Guardar Cambios'}
                </button>
              ) : (
                <button onClick={handleDispatch} disabled={saving}
                  className="bg-green-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                  {saving ? 'Despachando...' : 'Despachar y generar PIN'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
