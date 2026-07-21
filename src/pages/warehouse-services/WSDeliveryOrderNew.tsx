import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { collection, addDoc, getDocs, getDoc, doc, updateDoc, query, where, orderBy, limit, Timestamp } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import type { WSServiceOrder } from '../../types'
import { calculateTransportCharge } from '../../lib/wsBilling'

const TRUCKING_OPTIONS = ['CO-Transportation', 'GEO Transport', 'Other']

async function generateDONumber(): Promise<string> {
  const snap = await getDocs(
    query(collection(db, 'ws_delivery_orders'), orderBy('do_number', 'desc'), limit(1))
  )
  let seq = 1
  if (snap.docs.length > 0) {
    const last = snap.docs[0].data().do_number as string
    const num = parseInt(last.replace('WS-DO-', ''), 10)
    if (!isNaN(num)) seq = num + 1
  }
  return `WS-DO-${String(seq).padStart(5, '0')}`
}

export default function WSDeliveryOrderNew() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const soParam = searchParams.get('so') || ''
  const editId = searchParams.get('edit') || ''
  const { user, isAdmin, isSuperAgent, isAgent, isCounter, isBodega } = useAuth()
  const canCreate = isAdmin || isSuperAgent || isAgent || isCounter || isBodega

  const [orders, setOrders] = useState<WSServiceOrder[]>([])
  const [selectedSOId, setSelectedSOId] = useState('')
  const [selectedSO, setSelectedSO] = useState<WSServiceOrder | null>(null)

  const [truckingCompany, setTruckingCompany] = useState('CO-Transportation')
  const [truckingCustom, setTruckingCustom] = useState('')
  const [driverName, setDriverName] = useState('')
  const [transportType, setTransportType] = useState<'bup' | 'loose'>('loose')
  const [extraStops, setExtraStops] = useState(0)
  const [custodyMethod, setCustodyMethod] = useState<'seal' | 'escort' | 'locked_vehicle'>('seal')
  const [sealNumber, setSealNumber] = useState('')
  const [escortName, setEscortName] = useState('')
  const [mclAgent, setMclAgent] = useState('')
  const [saving, setSaving] = useState(false)
  const [doDocId, setDoDocId] = useState<string | null>(null)
  const [doNumber, setDoNumber] = useState('')

  useEffect(() => {
    setMclAgent(user?.email?.split('@')[0] || '')

    // Edit mode: load existing DO
    if (editId) {
      getDoc(doc(db, 'ws_delivery_orders', editId)).then(snap => {
        if (!snap.exists()) return
        const data = snap.data()
        setDoDocId(snap.id)
        setDoNumber(data.do_number || '')
        setTruckingCompany(TRUCKING_OPTIONS.includes(data.trucking_company) ? data.trucking_company : 'Other')
        if (!TRUCKING_OPTIONS.includes(data.trucking_company)) setTruckingCustom(data.trucking_company || '')
        setDriverName(data.driver_name || '')
        setTransportType(data.transport_type || 'loose')
        setExtraStops(data.extra_stops || 0)
        setCustodyMethod(data.custody_method || 'seal')
        setSealNumber(data.seal_number || '')
        setEscortName(data.escort_name || '')
        setMclAgent(data.mcl_agent || '')
        setSelectedSOId(data.so_id || '')
        // Load the linked SO
        if (data.so_id) {
          getDoc(doc(db, 'warehouse_service_orders', data.so_id)).then(soSnap => {
            if (soSnap.exists()) {
              const so = { id: soSnap.id, ...soSnap.data() } as WSServiceOrder
              setOrders([so])
              setSelectedSO(so)
            }
          })
        }
      })
      return
    }

    // If coming from a specific SO, load it directly and pre-select
    if (soParam) {
      getDoc(doc(db, 'warehouse_service_orders', soParam)).then(snap => {
        if (snap.exists()) {
          const so = { id: snap.id, ...snap.data() } as WSServiceOrder
          setOrders([so])
          setSelectedSOId(so.id!)
          setSelectedSO(so)
        }
      })
      return
    }

    // Load SOs available for delivery (no DO assigned yet, with transport service)
    getDocs(query(
      collection(db, 'warehouse_service_orders'),
      where('global_status', 'in', ['checked_in', 'received', 'in_progress']),
      orderBy('created_at', 'desc'),
    )).then(snap => {
      const available = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(so => !so.do_id && (so.service_items || []).some((i: any) => i.type === 'transport'))
      setOrders(available as WSServiceOrder[])
    })
  }, [soParam, editId])

  function handleSelectSO(soId: string) {
    setSelectedSOId(soId)
    setSelectedSO(orders.find(o => o.id === soId) || null)
  }

  async function handleSave() {
    if (!selectedSO) { alert('Select a service order.'); return }
    if (!driverName.trim()) { alert('Driver name is required.'); return }

    setSaving(true)
    try {
      const now = new Date().toISOString()
      const trucking = truckingCompany === 'Other' ? truckingCustom.trim() : truckingCompany

      const data = {
        so_id: selectedSO.id,
        so_number: selectedSO.so_number,
        client_id: selectedSO.client_id,
        client_name: selectedSO.client_name,
        awb_number: selectedSO.awb_number || null,
        pieces: selectedSO.declared_pieces,
        weight: selectedSO.declared_weight,
        trucking_company: trucking,
        driver_name: driverName.trim(),
        transport_type: transportType,
        extra_stops: extraStops,
        custody_method: custodyMethod,
        seal_number: custodyMethod === 'seal' ? sealNumber.trim() : '',
        escort_name: custodyMethod === 'escort' ? escortName.trim() : '',
        mcl_agent: mclAgent.trim(),
      }

      if (doDocId) {
        // Update existing DO
        await updateDoc(doc(db, 'ws_delivery_orders', doDocId), { ...data, updated_at: now })
      } else {
        // Create new DO
        const newDoNumber = await generateDONumber()
        const doRef = await addDoc(collection(db, 'ws_delivery_orders'), {
          ...data,
          do_number: newDoNumber,
          status: 'complete',
          created_at: now,
          created_by: user?.email || '',
        })

        // Link DO to SO: save do_id, complete transport, generate billing charge
        if (selectedSO?.id) {
          const soSnap = await getDoc(doc(db, 'warehouse_service_orders', selectedSO.id))
          if (soSnap.exists()) {
            const soData = soSnap.data() as WSServiceOrder
            const updatedItems = (soData.service_items || []).map(item => {
              if (item.type === 'transport' && (item.status === 'pending' || item.status === 'in_progress')) {
                return { ...item, status: 'completed' as const, started_at: item.started_at || now, completed_at: now, completed_by: user?.email || null }
              }
              return item
            })

            // Check if all services are now completed (transport was the only pending one)
            const allDone = updatedItems.every(i => i.status === 'completed' || i.status === 'cancelled' || i.status === 'fail')
            const hasOnlyTransport = updatedItems.filter(i => i.type !== 'in_out' && i.type !== 'storage').every(i => i.type === 'transport' || i.status === 'completed' || i.status === 'cancelled' || i.status === 'fail')

            const soUpdate: Record<string, unknown> = {
              do_id: doRef.id,
              do_number: newDoNumber,
              service_items: updatedItems,
              global_status: 'in_progress',
            }

            // If only transport (no other non-auto services), complete the SO
            const nonAutoNonTransport = updatedItems.filter(i => i.type !== 'in_out' && i.type !== 'storage' && i.type !== 'transport')
            if (nonAutoNonTransport.length === 0 || nonAutoNonTransport.every(i => i.status === 'completed' || i.status === 'cancelled' || i.status === 'fail')) {
              // Auto-complete in_out/storage
              const finalItems = updatedItems.map(item => {
                if ((item.type === 'in_out' || item.type === 'storage') && item.status === 'in_progress') {
                  return { ...item, status: 'completed' as const, completed_at: now, completed_by: user?.email || null }
                }
                return item
              })
              soUpdate.service_items = finalItems
              soUpdate.completed_at = now
              soUpdate.global_status = 'completed'
            }

            await updateDoc(doc(db, 'warehouse_service_orders', selectedSO.id), soUpdate)

            // Generate billing charge for transport with calculated amount
            const transportCharge = await calculateTransportCharge(
              soData as WSServiceOrder,
              transportType,
              extraStops,
              trucking,
              driverName.trim(),
            )
            await addDoc(collection(db, 'ws_billing_charges'), {
              so_id: selectedSO.id,
              so_number: soData.so_number,
              client_id: soData.client_id,
              client_name: soData.client_name,
              service_type: 'transport',
              description: transportCharge.description,
              amount: transportCharge.amount,
              currency: 'USD',
              status: 'pending',
              rate_id: transportCharge.rate_id,
              qty: transportCharge.qty || null,
              rate_price: transportCharge.rate_price || null,
              rate_unit: transportCharge.rate_unit || null,
              detail: transportCharge.detail || null,
              created_at: now,
              created_by: user?.email || '',
              do_id: doRef.id,
              do_number: newDoNumber,
            })
          }
        }
      }

      navigate('/warehouse-services/delivery-orders')
    } catch (e) {
      alert('Error: ' + (e instanceof Error ? e.message : String(e)))
    }
    setSaving(false)
  }

  const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30'
  const labelClass = 'text-xs font-semibold text-gray-500 uppercase block mb-1'

  if (!canCreate) {
    return <Layout title="Delivery Order" backTo="/warehouse-services"><p className="text-center text-gray-500 mt-10">Access restricted</p></Layout>
  }

  return (
    <Layout title={doDocId ? `Edit ${doNumber}` : 'New Delivery Order'} backTo="/warehouse-services/delivery-orders">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="bg-white rounded-xl shadow-sm border">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="font-bold text-gray-800">{doDocId ? `Edit ${doNumber}` : 'Delivery Order — Warehouse Services'}</h3>
          </div>

          <div className="px-6 py-5 space-y-4">
            {/* SO selector */}
            <div>
              <label className={labelClass}>Service Order</label>
              <select value={selectedSOId} onChange={e => handleSelectSO(e.target.value)} className={inputClass}>
                <option value="">Select SO...</option>
                {orders.map(o => (
                  <option key={o.id} value={o.id!}>
                    {o.so_number} — {o.client_name} {o.awb_number ? `(${o.awb_number})` : ''}
                  </option>
                ))}
              </select>
            </div>

            {selectedSO && (
              <div className="p-3 bg-gray-50 rounded-lg text-sm">
                <div className="grid grid-cols-3 gap-2">
                  <div><span className="text-xs text-gray-400">Client:</span> {selectedSO.client_name}</div>
                  <div><span className="text-xs text-gray-400">Pieces:</span> {selectedSO.declared_pieces}</div>
                  <div><span className="text-xs text-gray-400">Weight:</span> {selectedSO.declared_weight || '—'} kg</div>
                </div>
              </div>
            )}

            {/* Cargo / Transport type */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Transport Type</label>
                <div className="flex gap-2">
                  {([['bup', 'BUP / ULD'], ['loose', 'Loose Cargo']] as const).map(([v, l]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setTransportType(v)}
                      className={`flex-1 text-xs py-2 rounded-lg border transition-colors ${transportType === v ? 'bg-mcl-blue text-white border-mcl-blue' : 'bg-white text-gray-600 border-gray-200'}`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className={labelClass}>Extra Stops</label>
                <input type="number" min="0" value={extraStops} onChange={e => setExtraStops(parseInt(e.target.value) || 0)} className={inputClass} />
                {extraStops > 0 && <p className="text-[10px] text-amber-600 mt-1">+$40 per additional stop</p>}
              </div>
            </div>

            {/* Transport fields */}
            <div>
              <label className={labelClass}>Trucking Company</label>
              <select value={truckingCompany} onChange={e => setTruckingCompany(e.target.value)} className={inputClass}>
                {TRUCKING_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              {truckingCompany === 'Other' && (
                <input value={truckingCustom} onChange={e => setTruckingCustom(e.target.value)} placeholder="Company name" className={inputClass + ' mt-2'} />
              )}
            </div>

            <div>
              <label className={labelClass}>Driver</label>
              <input value={driverName} onChange={e => setDriverName(e.target.value)} className={inputClass} />
            </div>

            <div>
              <label className={labelClass}>Custody Method</label>
              <div className="flex gap-2">
                {[
                  { v: 'seal' as const, l: 'Tamper Seal' },
                  { v: 'escort' as const, l: 'Escort' },
                  { v: 'locked_vehicle' as const, l: 'Locked Vehicle' },
                ].map(opt => (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => setCustodyMethod(opt.v)}
                    className={`flex-1 text-xs py-2 rounded-lg border transition-colors ${custodyMethod === opt.v ? 'bg-mcl-blue text-white border-mcl-blue' : 'bg-white text-gray-600 border-gray-200'}`}
                  >
                    {opt.l}
                  </button>
                ))}
              </div>
              {custodyMethod === 'seal' && (
                <input value={sealNumber} onChange={e => setSealNumber(e.target.value)} placeholder="Seal #" className={inputClass + ' mt-2'} />
              )}
              {custodyMethod === 'escort' && (
                <input value={escortName} onChange={e => setEscortName(e.target.value)} placeholder="Escort name" className={inputClass + ' mt-2'} />
              )}
            </div>

            <div>
              <label className={labelClass}>MCL Agent</label>
              <input value={mclAgent} onChange={e => setMclAgent(e.target.value)} className={inputClass} />
            </div>
          </div>

          <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
            <button onClick={() => navigate('/warehouse-services/delivery-orders')} className="text-sm text-gray-500 hover:text-gray-700 px-4 py-2" disabled={saving}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving} className="text-sm bg-mcl-blue hover:bg-blue-900 text-white font-semibold px-5 py-2 rounded-lg disabled:opacity-50">
              {saving ? 'Saving...' : doDocId ? 'Save Changes' : 'Create DO'}
            </button>
          </div>
        </div>
      </div>
    </Layout>
  )
}
