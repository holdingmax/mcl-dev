import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, addDoc, getDocs, query, where, orderBy, limit, runTransaction, doc } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import type { WSServiceType, WSServiceItem, WSCargoType, WSCargoMode, WSClient, WSCargoLine, WSTransportType, WSBreakdownAwb } from '../../types'

const SERVICE_OPTIONS: { type: WSServiceType; label: string; group: string }[] = [
  { type: 'screening_k9', label: 'Screening K9', group: 'Screening' },
  { type: 'screening_xray', label: 'Screening X-Ray', group: 'Screening' },
  { type: 'screening_manual', label: 'Screening Manual', group: 'Screening' },
  { type: 'transport', label: 'Transport', group: 'Transport' },
  { type: 'storage', label: 'Storage', group: 'Warehouse' },
  { type: 'in_out', label: 'In/Out', group: 'Warehouse' },
  { type: 'repack', label: 'Repack', group: 'Warehouse' },
  { type: 'dg_inspection', label: 'DG Inspection', group: 'Warehouse' },
  { type: 'handling_storage_fee', label: 'Handling & Storage Fee', group: 'Warehouse' },
  { type: 'breakdown_bup', label: 'Breakdown BUP', group: 'Warehouse' },
]

const CARGO_TYPES: { value: WSCargoType; label: string }[] = [
  { value: 'GENERAL', label: 'General' },
  { value: 'SPECIAL', label: 'Special Cargo' },
  { value: 'DG', label: 'Dangerous Goods' },
  { value: 'PERISHABLE', label: 'Perishable' },
  { value: 'OVERSIZE', label: 'Oversize' },
  { value: 'OTHER', label: 'Other' },
]

// Generate SO number: SO-YYMMDD-NNNN
async function generateSONumber(): Promise<string> {
  const now = new Date()
  const yy = String(now.getFullYear()).slice(-2)
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const prefix = `SO-${yy}${mm}${dd}-`

  const snap = await getDocs(
    query(
      collection(db, 'warehouse_service_orders'),
      where('so_number', '>=', prefix),
      where('so_number', '<=', prefix + '\uf8ff'),
      orderBy('so_number', 'desc'),
      limit(1),
    ),
  )

  let seq = 1
  if (snap.docs.length > 0) {
    const lastNum = snap.docs[0].data().so_number as string
    const lastSeq = parseInt(lastNum.split('-').pop() || '0', 10)
    seq = lastSeq + 1
  }

  return `${prefix}${String(seq).padStart(4, '0')}`
}

function makeServiceItem(type: WSServiceType): WSServiceItem {
  const screeningMethod = type === 'screening_k9' ? 'k9' as const
    : type === 'screening_xray' ? 'xray' as const
    : type === 'screening_manual' ? 'manual' as const
    : null
  return {
    id: `srv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    status: 'pending',
    started_at: null,
    completed_at: null,
    completed_by: null,
    notes: '',
    location: null,
    pickup_from: null,
    deliver_to: null,
    scheduled_at: null,
    do_id: null,
    method: screeningMethod,
    inspection_log_id: null,
    cert_url: null,
    report_pdf_url: null,
  }
}

export default function WSOrderNew() {
  const navigate = useNavigate()
  const { user, isClient, clientId, isAdmin, isSuperAgent, isAgent, isCounter, isBodega, isAccounting } = useAuth()
  const canCreate = isAdmin || isSuperAgent || isAgent || isCounter || isBodega || isClient
  const visibleServices = SERVICE_OPTIONS.filter(s => s.type !== 'handling_storage_fee' || isAdmin || isAccounting)

  // Client selection
  const [clients, setClients] = useState<WSClient[]>([])
  const [selectedClientId, setSelectedClientId] = useState('')
  const [selectedClientName, setSelectedClientName] = useState('')
  const [showNewClient, setShowNewClient] = useState(false)
  const [newClientName, setNewClientName] = useState('')
  const [newClientEmail, setNewClientEmail] = useState('')
  const [newClientPhone, setNewClientPhone] = useState('')

  // Services
  const [selectedServices, setSelectedServices] = useState<Set<WSServiceType>>(new Set())

  // Normal SO fields
  const [awbNumber, setAwbNumber] = useState('')
  const [reference, setReference] = useState('')
  const [declaredPieces, setDeclaredPieces] = useState('')
  const [declaredWeight, setDeclaredWeight] = useState('')
  const [cargoDescription, setCargoDescription] = useState('')
  const [cargoType, setCargoType] = useState<WSCargoType>('GENERAL')
  const [cargoMode, setCargoMode] = useState<WSCargoMode>('LOC')

  // Notes / comments
  const [notes, setNotes] = useState('')

  // Transport fields (used in both normal+transport and transport-only)
  const [pickupFrom, setPickupFrom] = useState('')
  const [deliverTo, setDeliverTo] = useState('')
  const [extraStops, setExtraStops] = useState<string[]>([])

  // Transport-only fields
  const [transportType, setTransportType] = useState<WSTransportType>('loose')
  const [bupCount, setBupCount] = useState('')
  const [uldNumbers, setUldNumbers] = useState<string[]>([])
  const [uldInput, setUldInput] = useState('')
  const [cargoLines, setCargoLines] = useState<WSCargoLine[]>([])

  // Breakdown BUP multi-AWB
  const [breakdownAwbs, setBreakdownAwbs] = useState<WSBreakdownAwb[]>([])

  // Driver / check-in (normal SO only)
  const [driverPresent, setDriverPresent] = useState(false)
  const [driverName, setDriverName] = useState('')
  const [driverLicense, setDriverLicense] = useState('')

  const [saving, setSaving] = useState(false)

  // Detect transport-only
  const isTransportOnly = selectedServices.size === 1 && selectedServices.has('transport')
  const isFeeOnly = selectedServices.size === 1 && selectedServices.has('handling_storage_fee')
  const hasTransport = selectedServices.has('transport')
  const isBreakdownBup = selectedServices.has('breakdown_bup')

  // Auto-sum from cargo lines
  const clTotalPcs = cargoLines.reduce((s, l) => s + (l.pieces || 0), 0)
  const clTotalKg = cargoLines.reduce((s, l) => s + (l.weight_kg || 0), 0)

  // Auto-sum from breakdown AWBs
  const bdTotalPcs = breakdownAwbs.reduce((s, a) => s + (a.pieces || 0), 0)
  const bdTotalKg = breakdownAwbs.reduce((s, a) => s + (a.weight_kg || 0), 0)

  // Load clients
  useEffect(() => {
    getDocs(query(collection(db, 'warehouse_service_clients'), orderBy('name'))).then(snap => {
      setClients(snap.docs.map(d => ({ id: d.id, ...d.data() } as WSClient)).filter(c => c.active !== false))
    })
  }, [])

  useEffect(() => {
    if (isClient && clientId) {
      setSelectedClientId(clientId)
      const c = clients.find(c => c.id === clientId)
      if (c) setSelectedClientName(c.name)
    }
  }, [isClient, clientId, clients])

  function toggleService(type: WSServiceType) {
    setSelectedServices(prev => {
      const next = new Set(prev)
      if (next.has(type)) {
        next.delete(type)
      } else {
        if (type.startsWith('screening_')) {
          for (const t of next) {
            if (t.startsWith('screening_')) next.delete(t)
          }
        }
        next.add(type)
      }
      return next
    })
  }

  async function handleCreateClient(): Promise<string> {
    const ref = await addDoc(collection(db, 'warehouse_service_clients'), {
      name: newClientName.trim(),
      company_legal_name: '',
      contact_name: newClientName.trim(),
      contact_email: newClientEmail.trim(),
      contact_phone: newClientPhone.trim(),
      address: '',
      tax_id: null,
      type: 'spot',
      email_recipients: newClientEmail.trim() ? [{ name: newClientName.trim(), email: newClientEmail.trim() }] : [],
      billing_address: '',
      payment_terms_days: 30,
      payment_terms_label: 'N30',
      active: true,
      notes: '',
      created_at: new Date().toISOString(),
    })
    return ref.id
  }

  async function handleSubmit(withCheckIn: boolean) {
    if (selectedServices.size === 0) { alert('Select at least one service.'); return }
    if (!selectedClientId && !newClientName.trim()) { alert('Select or create a client.'); return }

    // Validation differs by mode
    if (isFeeOnly) {
      // Fee-only: no cargo data needed
    } else if (isTransportOnly) {
      if (cargoLines.length === 0 && !declaredPieces) { alert('Add at least one cargo line or enter pieces.'); return }
    } else if (isBreakdownBup) {
      if (breakdownAwbs.length === 0) { alert('Add at least one AWB for Breakdown BUP.'); return }
      if (breakdownAwbs.some(a => !a.awb_number.trim())) { alert('All AWBs must have a number.'); return }
    } else {
      if (!declaredPieces || parseInt(declaredPieces) <= 0) { alert('Enter the declared pieces.'); return }
      if (withCheckIn && !driverName.trim()) { alert('Enter the driver name for check-in.'); return }
    }

    setSaving(true)
    try {
      let cId = selectedClientId
      let cName = selectedClientName
      if (!cId && newClientName.trim()) {
        cId = await handleCreateClient()
        cName = newClientName.trim()
      }

      const soNumber = await generateSONumber()
      const now = new Date().toISOString()

      const serviceItems: WSServiceItem[] = Array.from(selectedServices).map(type => {
        const item = makeServiceItem(type)
        if (type === 'transport') {
          item.pickup_from = pickupFrom || null
          item.deliver_to = deliverTo || null
        }
        return item
      })

      const totalPieces = isBreakdownBup
        ? bdTotalPcs
        : isTransportOnly && cargoLines.length > 0
          ? clTotalPcs
          : (parseInt(declaredPieces) || 0)
      const totalWeight = isBreakdownBup
        ? bdTotalKg
        : isTransportOnly && cargoLines.length > 0
          ? clTotalKg
          : (parseFloat(declaredWeight) || 0)

      const feeOnlyStatus = isFeeOnly ? 'completed' as const : null

      const order: Record<string, unknown> = {
        so_number: soNumber,
        client_id: cId,
        client_name: cName,
        awb_number: (isTransportOnly || isFeeOnly) ? null : (awbNumber.trim() || null),
        reference: (isTransportOnly || isFeeOnly) ? (reference.trim() || null) : (reference.trim() || null),
        service_items: serviceItems,
        global_status: feeOnlyStatus || (withCheckIn ? 'checked_in' as const : 'requested' as const),
        declared_pieces: totalPieces,
        declared_weight: totalWeight,
        cargo_description: cargoDescription.trim(),
        cargo_type: cargoType,
        cargo_mode: cargoMode,
        notes: notes.trim() || null,
        wr_id: null,
        do_ids: [],
        driver_name: withCheckIn ? driverName.trim() : null,
        driver_license: withCheckIn ? driverLicense.trim() : null,
        driver_photo_url: null,
        counter_agent: withCheckIn ? (user?.email || null) : null,
        checked_in_at: withCheckIn ? now : null,
        received_at: null,
        completed_at: null,
        billed_at: null,
        created_by: user?.email || 'unknown',
        created_at: now,
      }

      if (isFeeOnly) {
        order.fee_only = true
        order.completed_at = now
        // Mark service item as completed
        serviceItems.forEach(si => { si.status = 'completed'; si.completed_at = now; si.completed_by = user?.email || null })
      }

      if (isTransportOnly) {
        order.transport_only = true
        order.transport_type = transportType
        order.bup_count = transportType === 'bup' ? (parseInt(bupCount) || null) : null
        order.uld_numbers = transportType === 'bup' ? uldNumbers : []
        order.cargo_lines = cargoLines
        order.extra_stops = extraStops.filter(s => s.trim())
        order.pickup_from = pickupFrom.trim() || null
        order.deliver_to = deliverTo.trim() || null
      }

      if (isBreakdownBup) {
        order.breakdown_awbs = breakdownAwbs.map(a => ({
          awb_number: a.awb_number.trim(),
          pieces: a.pieces,
          weight_kg: a.weight_kg,
          received_pieces: null,
          received_weight_kg: null,
          confirmed: false,
        }))
      }

      const ref = await addDoc(collection(db, 'warehouse_service_orders'), order)
      navigate(`/warehouse-services/orders/${ref.id}`)
    } catch (e) {
      alert('Error creating order: ' + (e instanceof Error ? e.message : String(e)))
    }
    setSaving(false)
  }

  const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30'
  const labelClass = 'text-xs font-semibold text-gray-500 uppercase block mb-1'

  if (!canCreate) {
    return <Layout title="New Service Order" backTo="/warehouse-services"><p className="text-center text-gray-500 mt-10">Access restricted</p></Layout>
  }

  return (
    <Layout title="New Service Order" backTo="/warehouse-services">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="bg-white rounded-xl shadow-sm border">
          {/* Header */}
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-lg font-bold text-gray-800">Service Order</h2>
            <p className="text-xs text-gray-400 mt-1">Create a new warehouse service order</p>
          </div>

          <div className="px-6 py-5 space-y-5">
            {/* ── 1. CLIENT ── */}
            <div>
              <label className={labelClass}>Client</label>
              {!showNewClient ? (
                <div className="flex gap-2">
                  <select
                    value={selectedClientId}
                    onChange={e => {
                      setSelectedClientId(e.target.value)
                      const c = clients.find(c => c.id === e.target.value)
                      setSelectedClientName(c?.name || '')
                    }}
                    className={inputClass + ' flex-1'}
                    disabled={isClient}
                  >
                    <option value="">Select client...</option>
                    {clients.map(c => (
                      <option key={c.id} value={c.id!}>{c.name}</option>
                    ))}
                  </select>
                  {!isClient && (
                    <button
                      type="button"
                      onClick={() => setShowNewClient(true)}
                      className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-2 rounded-lg whitespace-nowrap"
                    >
                      + New
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-2 p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-600">New Client (minimum info)</span>
                    <button type="button" onClick={() => setShowNewClient(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                  </div>
                  <input placeholder="Name / Company *" value={newClientName} onChange={e => setNewClientName(e.target.value)} className={inputClass} />
                  <div className="grid grid-cols-2 gap-2">
                    <input placeholder="Email" value={newClientEmail} onChange={e => setNewClientEmail(e.target.value)} className={inputClass} />
                    <input placeholder="Phone" value={newClientPhone} onChange={e => setNewClientPhone(e.target.value)} className={inputClass} />
                  </div>
                </div>
              )}
            </div>

            {/* ── 2. SERVICES ── */}
            <div>
              <label className={labelClass}>Services</label>
              <div className="space-y-3">
                {['Screening', 'Transport', 'Warehouse'].map(group => (
                  <div key={group}>
                    <div className="text-[10px] font-bold text-gray-400 uppercase mb-1.5">{group}</div>
                    <div className="flex flex-wrap gap-2">
                      {visibleServices.filter(s => s.group === group).map(s => {
                        const active = selectedServices.has(s.type)
                        return (
                          <button
                            key={s.type}
                            type="button"
                            onClick={() => toggleService(s.type)}
                            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                              active
                                ? 'bg-mcl-blue text-white border-mcl-blue'
                                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                            }`}
                          >
                            {s.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── 3F. FEE-ONLY ── */}
            {isFeeOnly && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>Reference / PO (optional)</label>
                    <input value={reference} onChange={e => setReference(e.target.value)} placeholder="PO-12345" className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Description</label>
                    <input value={cargoDescription} onChange={e => setCargoDescription(e.target.value)} placeholder="Handling & Storage Fee - May 2026" className={inputClass} />
                  </div>
                </div>
              </div>
            )}

            {/* ── 3A. NORMAL SO (not transport-only) ── */}
            {selectedServices.size > 0 && !isTransportOnly && !isFeeOnly && (
              <>
                {/* Reference + AWB (hidden for breakdown_bup since AWBs are in the table below) */}
                {!isBreakdownBup && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelClass}>Reference / PO</label>
                      <input value={reference} onChange={e => setReference(e.target.value)} placeholder="PO-12345" className={inputClass} />
                    </div>
                    <div>
                      <label className={labelClass}>AWB (optional)</label>
                      <input value={awbNumber} onChange={e => setAwbNumber(e.target.value)} placeholder="045-12345678" className={inputClass} />
                    </div>
                  </div>
                )}

                {/* Breakdown BUP: Reference + multi-AWB table */}
                {isBreakdownBup && (
                  <div className="space-y-4">
                    <div>
                      <label className={labelClass}>Reference / PO (optional)</label>
                      <input value={reference} onChange={e => setReference(e.target.value)} placeholder="PO-12345" className={inputClass} />
                    </div>
                    <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                      <div className="flex items-center justify-between mb-3">
                        <label className="text-xs font-semibold text-amber-700 uppercase">AWBs for Breakdown</label>
                        <button
                          type="button"
                          onClick={() => setBreakdownAwbs([...breakdownAwbs, { awb_number: '', pieces: 0, weight_kg: 0 }])}
                          className="text-xs bg-white hover:bg-amber-100 text-amber-700 border border-amber-300 px-3 py-1.5 rounded-lg font-semibold"
                        >
                          + Add AWB
                        </button>
                      </div>
                      {breakdownAwbs.length === 0 ? (
                        <p className="text-xs text-amber-600 italic">No AWBs added yet. Click "+ Add AWB" to start.</p>
                      ) : (
                        <>
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-[10px] text-amber-600 uppercase">
                                <th className="text-left pb-1 pr-2 font-semibold">AWB Number *</th>
                                <th className="text-right pb-1 pr-2 font-semibold w-24">Pieces *</th>
                                <th className="text-right pb-1 pr-2 font-semibold w-28">Gross Wt (kg) *</th>
                                <th className="w-8"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {breakdownAwbs.map((awb, idx) => (
                                <tr key={idx}>
                                  <td className="pr-2 pb-2">
                                    <input
                                      value={awb.awb_number}
                                      onChange={e => { const a = [...breakdownAwbs]; a[idx] = { ...a[idx], awb_number: e.target.value }; setBreakdownAwbs(a) }}
                                      placeholder="045-12345678"
                                      className={inputClass + ' font-mono'}
                                    />
                                  </td>
                                  <td className="pr-2 pb-2">
                                    <input
                                      type="number" min="1"
                                      value={awb.pieces || ''}
                                      onChange={e => { const a = [...breakdownAwbs]; a[idx] = { ...a[idx], pieces: parseInt(e.target.value) || 0 }; setBreakdownAwbs(a) }}
                                      className={inputClass + ' text-right'}
                                    />
                                  </td>
                                  <td className="pr-2 pb-2">
                                    <input
                                      type="number" min="0" step="0.1"
                                      value={awb.weight_kg || ''}
                                      onChange={e => { const a = [...breakdownAwbs]; a[idx] = { ...a[idx], weight_kg: parseFloat(e.target.value) || 0 }; setBreakdownAwbs(a) }}
                                      className={inputClass + ' text-right'}
                                    />
                                  </td>
                                  <td className="pb-2">
                                    <button type="button" onClick={() => setBreakdownAwbs(breakdownAwbs.filter((_, j) => j !== idx))} className="text-red-400 hover:text-red-600 text-lg leading-none">&times;</button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <div className="flex items-center gap-4 mt-2 pt-2 border-t border-amber-200">
                            <span className="text-sm text-amber-800">Total Pieces: <strong>{bdTotalPcs.toLocaleString()}</strong></span>
                            <span className="text-sm text-amber-800">Total Weight: <strong>{bdTotalKg.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 })}</strong> kg</span>
                            <span className="text-xs bg-amber-200 text-amber-800 px-2.5 py-1 rounded-full font-semibold">{breakdownAwbs.length} AWB{breakdownAwbs.length !== 1 ? 's' : ''}</span>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* Transport route (when transport is among other services) */}
                {hasTransport && (
                  <div className="p-3 bg-gray-50 rounded-lg space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={labelClass}>Pickup from</label>
                        <input value={pickupFrom} onChange={e => setPickupFrom(e.target.value)} placeholder="Origin address" className={inputClass} />
                      </div>
                      <div>
                        <label className={labelClass}>Deliver to</label>
                        <input value={deliverTo} onChange={e => setDeliverTo(e.target.value)} placeholder="Destination address" className={inputClass} />
                      </div>
                    </div>
                    {extraStops.map((stop, i) => (
                      <div key={i} className="flex gap-2 items-end">
                        <div className="flex-1">
                          <label className={labelClass}>Extra Stop {i + 1}</label>
                          <input
                            value={stop}
                            onChange={e => { const s = [...extraStops]; s[i] = e.target.value; setExtraStops(s) }}
                            placeholder="Stop address"
                            className={inputClass}
                          />
                        </div>
                        <button type="button" onClick={() => setExtraStops(extraStops.filter((_, j) => j !== i))} className="text-xs text-red-400 hover:text-red-600 px-2 py-2">Remove</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => setExtraStops([...extraStops, ''])} className="text-xs text-mcl-blue hover:underline">+ Add Extra Stop</button>
                  </div>
                )}

                {/* Declared Cargo (hidden for breakdown_bup, auto-summed from AWBs) */}
                {!isBreakdownBup && (
                  <div>
                    <label className={labelClass}>Declared Cargo</label>
                    <div className="grid grid-cols-3 gap-3">
                      <input type="number" min="1" placeholder="Pieces *" value={declaredPieces} onChange={e => setDeclaredPieces(e.target.value)} className={inputClass} />
                      <input type="number" min="0" step="0.1" placeholder="Weight (kg)" value={declaredWeight} onChange={e => setDeclaredWeight(e.target.value)} className={inputClass} />
                      <select value={cargoType} onChange={e => setCargoType(e.target.value as WSCargoType)} className={inputClass}>
                        {CARGO_TYPES.map(ct => (
                          <option key={ct.value} value={ct.value}>{ct.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-xs text-gray-500 font-semibold">Mode:</span>
                      {(['LOC', 'BOND'] as WSCargoMode[]).map(m => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setCargoMode(m)}
                          className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                            cargoMode === m
                              ? 'bg-mcl-blue text-white border-mcl-blue'
                              : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          {m === 'LOC' ? 'Local' : 'Bonded'}
                        </button>
                      ))}
                    </div>
                    <input placeholder="Cargo description" value={cargoDescription} onChange={e => setCargoDescription(e.target.value)} className={inputClass + ' mt-2'} />
                    <textarea placeholder="Notes / special instructions (e.g. 16 wood pallets, fragile cargo...)" value={notes} onChange={e => setNotes(e.target.value)} rows={2} className={inputClass + ' mt-2 resize-none'} />
                  </div>
                )}

                {/* Breakdown BUP: Mode + Notes (simplified) */}
                {isBreakdownBup && (
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 font-semibold">Mode:</span>
                      {(['LOC', 'BOND'] as WSCargoMode[]).map(m => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setCargoMode(m)}
                          className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                            cargoMode === m
                              ? 'bg-mcl-blue text-white border-mcl-blue'
                              : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          {m === 'LOC' ? 'Local' : 'Bonded'}
                        </button>
                      ))}
                    </div>
                    <textarea placeholder="Notes / special instructions" value={notes} onChange={e => setNotes(e.target.value)} rows={2} className={inputClass + ' mt-2 resize-none'} />
                  </div>
                )}

                {/* Driver / Check-in */}
                <div className="border-t border-gray-100 pt-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={driverPresent}
                      onChange={e => setDriverPresent(e.target.checked)}
                      className="accent-mcl-blue"
                    />
                    <span className="text-sm text-gray-700 font-semibold">Driver present (check-in now)</span>
                  </label>
                  {driverPresent && (
                    <div className="mt-3 p-3 bg-gray-50 rounded-lg grid grid-cols-2 gap-3">
                      <div>
                        <label className={labelClass}>Driver Name</label>
                        <input value={driverName} onChange={e => setDriverName(e.target.value)} placeholder="Full name" className={inputClass} />
                      </div>
                      <div>
                        <label className={labelClass}>License #</label>
                        <input value={driverLicense} onChange={e => setDriverLicense(e.target.value)} placeholder="FL-123456" className={inputClass} />
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ── 3B. TRANSPORT ONLY ── */}
            {isTransportOnly && (
              <div className="space-y-5">
                {/* Cargo: Type + Mode + Description */}
                <div>
                  <label className={labelClass}>Cargo</label>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <span className="text-[10px] text-gray-400 block mb-0.5">Type</span>
                      <select value={cargoType} onChange={e => setCargoType(e.target.value as WSCargoType)} className={inputClass}>
                        {CARGO_TYPES.map(ct => (
                          <option key={ct.value} value={ct.value}>{ct.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <span className="text-[10px] text-gray-400 block mb-0.5">Mode</span>
                      <div className="flex gap-1 mt-0.5">
                        {(['LOC', 'BOND'] as WSCargoMode[]).map(m => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setCargoMode(m)}
                            className={`text-xs px-3 py-1.5 rounded-full border transition-colors font-semibold ${
                              cargoMode === m
                                ? 'bg-mcl-blue text-white border-mcl-blue'
                                : 'bg-white text-gray-600 border-gray-200'
                            }`}
                          >
                            {m === 'LOC' ? 'Local' : 'Bonded'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span className="text-[10px] text-gray-400 block mb-0.5">Description</span>
                      <input value={cargoDescription} onChange={e => setCargoDescription(e.target.value)} placeholder="e.g. Electronic parts" className={inputClass} />
                    </div>
                  </div>
                  <textarea placeholder="Notes / special instructions (e.g. 16 wood pallets, fragile cargo...)" value={notes} onChange={e => setNotes(e.target.value)} rows={2} className={inputClass + ' mt-2 resize-none'} />
                </div>

                {/* Transport Type: BUP / Loose */}
                <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg space-y-3">
                  <div>
                    <label className="text-xs font-semibold text-emerald-700 uppercase block mb-1">Transport Type *</label>
                    <div className="flex gap-2">
                      {(['bup', 'loose'] as WSTransportType[]).map(t => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setTransportType(t)}
                          className={`text-xs px-4 py-2 rounded-full border transition-colors font-semibold ${
                            transportType === t
                              ? 'bg-mcl-blue text-white border-mcl-blue'
                              : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          {t === 'bup' ? 'BUP / ULD' : 'Loose'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {transportType === 'bup' && (
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs font-semibold text-emerald-700 uppercase block mb-1">Number of BUPs *</label>
                        <input type="number" min="1" value={bupCount} onChange={e => setBupCount(e.target.value)} placeholder="3" className="w-32 border border-emerald-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400/40 bg-white font-semibold" />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-emerald-700 uppercase block mb-1">ULD / BUP Numbers (optional)</label>
                        <div className="flex gap-2">
                          <input
                            value={uldInput}
                            onChange={e => setUldInput(e.target.value)}
                            placeholder="e.g. AKE12345AA"
                            className={inputClass + ' flex-1 font-mono'}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && uldInput.trim()) {
                                e.preventDefault()
                                setUldNumbers([...uldNumbers, uldInput.trim()])
                                setUldInput('')
                              }
                            }}
                          />
                          <button type="button" onClick={() => { if (uldInput.trim()) { setUldNumbers([...uldNumbers, uldInput.trim()]); setUldInput('') } }} className="text-xs bg-white hover:bg-emerald-100 text-emerald-700 border border-emerald-300 px-3 py-1.5 rounded-lg font-semibold">Add</button>
                        </div>
                        {uldNumbers.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {uldNumbers.map((uld, i) => (
                              <span key={i} className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full flex items-center gap-1 font-mono">
                                {uld}
                                <button type="button" onClick={() => setUldNumbers(uldNumbers.filter((_, j) => j !== i))} className="text-blue-400 hover:text-red-500">&times;</button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Route */}
                <div>
                  <label className={labelClass}>Route</label>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <span className="text-[10px] text-gray-400 block mb-0.5">Pickup from *</span>
                      <input value={pickupFrom} onChange={e => setPickupFrom(e.target.value)} placeholder="Origin address" className={inputClass} />
                    </div>
                    <div>
                      <span className="text-[10px] text-gray-400 block mb-0.5">Deliver to *</span>
                      <input value={deliverTo} onChange={e => setDeliverTo(e.target.value)} placeholder="Destination address" className={inputClass} />
                    </div>
                  </div>
                  {extraStops.map((stop, i) => (
                    <div key={i} className="flex gap-2 items-end mt-2">
                      <div className="flex-1">
                        <span className="text-[10px] text-gray-400 block mb-0.5">Extra Stop {i + 1}</span>
                        <input
                          value={stop}
                          onChange={e => { const s = [...extraStops]; s[i] = e.target.value; setExtraStops(s) }}
                          placeholder="Stop address"
                          className={inputClass}
                        />
                      </div>
                      <button type="button" onClick={() => setExtraStops(extraStops.filter((_, j) => j !== i))} className="text-xs text-red-400 hover:text-red-600 px-2 py-2">Remove</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setExtraStops([...extraStops, ''])} className="text-xs text-mcl-blue hover:underline mt-2">+ Add Extra Stop</button>
                </div>

                {/* Cargo Lines */}
                <div>
                  <label className={labelClass}>Cargo Lines</label>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[10px] text-gray-400 uppercase">
                          <th className="text-left pb-1 pr-2 font-semibold">AWB</th>
                          <th className="text-left pb-1 pr-2 font-semibold">Reference / PO</th>
                          <th className="text-right pb-1 pr-2 font-semibold w-20">Pieces</th>
                          <th className="text-right pb-1 pr-2 font-semibold w-24">Weight (kg)</th>
                          <th className="text-left pb-1 pr-2 font-semibold">Note</th>
                          <th className="w-8"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {cargoLines.map((line, idx) => (
                          <tr key={line.id}>
                            <td className="pr-2 pb-2">
                              <input value={line.awb} onChange={e => { const c = [...cargoLines]; c[idx] = { ...c[idx], awb: e.target.value }; setCargoLines(c) }} placeholder="045-12345678" className={inputClass + ' font-mono'} />
                            </td>
                            <td className="pr-2 pb-2">
                              <input value={line.reference} onChange={e => { const c = [...cargoLines]; c[idx] = { ...c[idx], reference: e.target.value }; setCargoLines(c) }} placeholder="PO-12345" className={inputClass} />
                            </td>
                            <td className="pr-2 pb-2">
                              <input type="number" min="1" value={line.pieces || ''} onChange={e => { const c = [...cargoLines]; c[idx] = { ...c[idx], pieces: parseInt(e.target.value) || 0 }; setCargoLines(c) }} className={inputClass + ' text-right'} />
                            </td>
                            <td className="pr-2 pb-2">
                              <input type="number" min="0" step="0.1" value={line.weight_kg || ''} onChange={e => { const c = [...cargoLines]; c[idx] = { ...c[idx], weight_kg: parseFloat(e.target.value) || 0 }; setCargoLines(c) }} className={inputClass + ' text-right'} />
                            </td>
                            <td className="pr-2 pb-2">
                              <input value={line.note} onChange={e => { const c = [...cargoLines]; c[idx] = { ...c[idx], note: e.target.value }; setCargoLines(c) }} placeholder="Optional" className={inputClass} />
                            </td>
                            <td className="pb-2">
                              <button type="button" onClick={() => setCargoLines(cargoLines.filter((_, j) => j !== idx))} className="text-red-400 hover:text-red-600 text-lg leading-none">&times;</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCargoLines([...cargoLines, { id: `cl_${Date.now()}`, awb: '', reference: '', pieces: 0, weight_kg: 0, note: '' }])}
                    className="text-xs text-mcl-blue hover:underline mt-1"
                  >
                    + Add Line
                  </button>

                  {/* Totals */}
                  {cargoLines.length > 0 && (
                    <div className="flex items-center gap-4 mt-3 pt-3 border-t border-gray-100">
                      <span className="text-sm text-gray-700">Total Pieces: <strong>{clTotalPcs.toLocaleString()}</strong></span>
                      <span className="text-sm text-gray-700">Total Weight: <strong>{clTotalKg.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 })}</strong> kg</span>
                      {transportType === 'bup' && bupCount && (
                        <span className="text-xs bg-emerald-100 text-emerald-700 px-2.5 py-1 rounded-full font-semibold">
                          BUP: {bupCount} units
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
            <button
              onClick={() => navigate('/warehouse-services')}
              className="text-sm text-gray-500 hover:text-gray-700 px-4 py-2"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              onClick={() => handleSubmit(false)}
              disabled={saving}
              className="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold px-5 py-2 rounded-lg transition-colors disabled:opacity-50"
            >
              Create SO
            </button>
            {!isTransportOnly && !isFeeOnly && (
              <button
                onClick={() => handleSubmit(true)}
                disabled={saving}
                className="text-sm bg-mcl-blue hover:bg-blue-900 text-white font-semibold px-5 py-2 rounded-lg transition-colors disabled:opacity-50"
              >
                Create SO + Check-in
              </button>
            )}
          </div>
        </div>
      </div>
    </Layout>
  )
}
