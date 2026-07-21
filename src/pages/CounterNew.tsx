import { useState, useRef, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Layout from '../components/Layout'
import { db } from '../lib/firebase'
import {
  doc, getDoc, addDoc, updateDoc, collection, runTransaction, getDocs, query, orderBy
} from 'firebase/firestore'
import { useAuth } from '../contexts/AuthContext'
import { Consignee, SEA_DESTINATIONS, Client, ClientShipper, ClientConsignee } from '../types'

export default function CounterNew() {
  const { id } = useParams()
  const isEdit = !!id
  const navigate = useNavigate()
  const { user, isAdmin, isSuperAgent, canEdit } = useAuth()
  const photoInputRef = useRef<HTMLInputElement>(null)

  const [saving, setSaving] = useState(false)
  const [viewMode, setViewMode] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)

  // Legacy consignees (no client)
  const [consignees, setConsignees] = useState<Consignee[]>([])
  const [selectedConsigneeId, setSelectedConsigneeId] = useState('')
  const [legacyConsigneeMode, setLegacyConsigneeMode] = useState<'select' | 'manual'>('select')
  const [manualLegacyConsigneeName, setManualLegacyConsigneeName] = useState('')
  const [notifyTo, setNotifyTo] = useState('')

  // Clients
  const [clients, setClients] = useState<Client[]>([])
  const [selectedClient, setSelectedClient] = useState<Client | null>(null)
  const [clientMode, setClientMode] = useState<'select' | 'manual'>('select')
  const [manualClientName, setManualClientName] = useState('')

  // Shipper state
  const [shipperMode, setShipperMode] = useState<'select' | 'manual'>('select')
  const [selectedShipperIdx, setSelectedShipperIdx] = useState<number>(-1)
  const [manualShipperName, setManualShipperName] = useState('')

  // Consignee state (when client selected)
  const [consigneeMode, setConsigneeMode] = useState<'select' | 'manual'>('select')
  const [selectedConsigneeIdx, setSelectedConsigneeIdx] = useState<number>(-1)
  const [manualConsigneeName, setManualConsigneeName] = useState('')

  const [cargoType, setCargoType] = useState<'BOND' | 'LOC'>('LOC')

  const [form, setForm] = useState({
    company_name: '',
    po_number: '',
    to_port: '',
    driver_name: '',
    driver_license: '',
    declared_pieces: '',
    observations: '',
  })

  useEffect(() => {
    loadConsignees()
    loadClients()
  }, [])

  useEffect(() => {
    if (isEdit) loadWR()
  }, [id])

  async function loadConsignees() {
    const snap = await getDocs(collection(db, 'consignees'))
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() })) as Consignee[]
    setConsignees(data.sort((a, b) => a.name.localeCompare(b.name)))
  }

  async function loadClients() {
    const snap = await getDocs(query(collection(db, 'clients'), orderBy('name')))
    setClients(snap.docs.map(d => ({ id: d.id, ...d.data() })) as Client[])
  }

  const isReadOnly = isEdit && viewMode
  const canOpenEdit = canEdit // agent, super_agent, admin
  const canEditWR = isAdmin || isSuperAgent // only admin + super_agent can navigate to WR edit

  async function loadWR() {
    const snap = await getDoc(doc(db, 'warehouse_receipts', id!))
    if (!snap.exists()) return
    const data = snap.data()
    setViewMode(true) // open in read-only by default

    setForm({
      company_name: data.company_name || '',
      po_number: data.po_number || '',
      to_port: data.to_port || '',
      driver_name: data.driver_name || '',
      driver_license: data.driver_license || '',
      declared_pieces: data.declared_pieces?.toString() || '',
      observations: data.observations || '',
    })
    if (data.cargo_type) setCargoType(data.cargo_type)
    if (data.driver_license_photo_url) setPhotoPreview(data.driver_license_photo_url)

    if (data.client_id) {
      // Load client and restore dropdowns
      const clientSnap = await getDoc(doc(db, 'clients', data.client_id))
      if (clientSnap.exists()) {
        const client = { id: clientSnap.id, ...clientSnap.data() } as Client
        setSelectedClient(client)

        // Restore shipper
        const shipperIdx = client.shippers.findIndex(s => s.name === data.company_name)
        if (shipperIdx >= 0) {
          setShipperMode('select')
          setSelectedShipperIdx(shipperIdx)
        } else {
          setShipperMode('manual')
          setManualShipperName(data.company_name || '')
        }

        // Restore consignee
        const savedConsigneeName = data.consignee_name || ''
        const consigneeIdx = client.consignees.findIndex(c => c.name === savedConsigneeName)
        if (consigneeIdx >= 0) {
          setConsigneeMode('select')
          setSelectedConsigneeIdx(consigneeIdx)
          setNotifyTo(client.consignees[consigneeIdx].notify_to || '')
        } else if (savedConsigneeName) {
          setConsigneeMode('manual')
          setManualConsigneeName(savedConsigneeName)
          setNotifyTo(data.notify_to || '')
        }
      }
    } else {
      // Legacy WR — load in manual client mode
      setClientMode('manual')
      setManualClientName(data.client_name || '')
      setSelectedConsigneeId(data.consignee_id || '')
      setNotifyTo(data.notify_to || '')
    }
  }

  function handleClientChange(clientId: string) {
    if (clientId === '__manual__') {
      setClientMode('manual')
      setSelectedClient(null)
      setManualClientName('')
      setShipperMode('select')
      setSelectedShipperIdx(-1)
      setManualShipperName('')
      setConsigneeMode('select')
      setSelectedConsigneeIdx(-1)
      setManualConsigneeName('')
      set('company_name', '')
      setSelectedConsigneeId('')
      setNotifyTo('')
      return
    }
    setClientMode('select')
    if (!clientId) {
      setSelectedClient(null)
      setShipperMode('select')
      setSelectedShipperIdx(-1)
      setConsigneeMode('select')
      setSelectedConsigneeIdx(-1)
      set('company_name', '')
      setSelectedConsigneeId('')
      setNotifyTo('')
      return
    }
    const client = clients.find(c => c.id === clientId) || null
    setSelectedClient(client)
    // Reset shipper/consignee selections
    setShipperMode('select')
    setSelectedShipperIdx(-1)
    setManualShipperName('')
    set('company_name', '')
    setConsigneeMode('select')
    setSelectedConsigneeIdx(-1)
    setManualConsigneeName('')
    setSelectedConsigneeId('')
    setNotifyTo('')
  }

  function handleShipperSelectChange(val: string) {
    if (val === '__manual__') {
      setShipperMode('manual')
      setSelectedShipperIdx(-1)
      setManualShipperName('')
      set('company_name', '')
    } else {
      const idx = parseInt(val)
      setSelectedShipperIdx(idx)
      if (selectedClient && selectedClient.shippers[idx]) {
        set('company_name', selectedClient.shippers[idx].name)
      }
    }
  }

  function handleConsigneeSelectChange(val: string) {
    if (val === '__manual__') {
      setConsigneeMode('manual')
      setSelectedConsigneeIdx(-1)
      setManualConsigneeName('')
      setSelectedConsigneeId('')
      setNotifyTo('')
    } else {
      const idx = parseInt(val)
      setSelectedConsigneeIdx(idx)
      if (selectedClient && selectedClient.consignees[idx]) {
        const c = selectedClient.consignees[idx]
        setManualConsigneeName(c.name)
        setNotifyTo(c.notify_to || '')
        setSelectedConsigneeId('') // client-based, no legacy consignee_id
      }
    }
  }

  // Legacy (no client) consignee handler
  function handleLegacyConsigneeChange(consigneeId: string) {
    if (consigneeId === '__manual__') {
      setLegacyConsigneeMode('manual')
      setSelectedConsigneeId('')
      setManualLegacyConsigneeName('')
      setNotifyTo('')
      return
    }
    setSelectedConsigneeId(consigneeId)
    const found = consignees.find(c => c.id === consigneeId)
    setNotifyTo(found?.notify_to || '')
  }

  function set(field: string, value: string) {
    setForm(f => ({ ...f, [field]: value }))
  }

  function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setPhotoFile(file)
    setPhotoPreview(URL.createObjectURL(file))
  }

  async function toBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const url = URL.createObjectURL(file)
      img.onload = () => {
        const MAX = 700
        let { width, height } = img
        if (width > MAX || height > MAX) {
          if (width > height) { height = Math.round(height * MAX / width); width = MAX }
          else { width = Math.round(width * MAX / height); height = MAX }
        }
        const canvas = document.createElement('canvas')
        canvas.width = width; canvas.height = height
        canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
        URL.revokeObjectURL(url)
        resolve(canvas.toDataURL('image/jpeg', 0.75))
      }
      img.onerror = reject
      img.src = url
    })
  }

  async function getNextWRNumber(): Promise<string> {
    const seqRef = doc(db, 'config', 'wr_sequence')
    const nextNum = await runTransaction(db, async (tx) => {
      const seqDoc = await tx.get(seqRef)
      const current = seqDoc.exists() ? (seqDoc.data().last_num || 0) : 0
      const next = current + 1
      tx.set(seqRef, { last_num: next })
      return next
    })
    return 'LI' + String(nextNum).padStart(10, '0')
  }

  // Derive the effective company_name and consignee info
  function getEffectiveCompanyName(): string {
    if (selectedClient) {
      if (shipperMode === 'manual') return manualShipperName.trim()
      if (selectedShipperIdx >= 0 && selectedClient.shippers[selectedShipperIdx]) {
        return selectedClient.shippers[selectedShipperIdx].name
      }
      return ''
    }
    return form.company_name
  }

  function getEffectiveConsigneeName(): string {
    if (selectedClient) {
      if (consigneeMode === 'manual') return manualConsigneeName.trim()
      if (selectedConsigneeIdx >= 0 && selectedClient.consignees[selectedConsigneeIdx]) {
        return selectedClient.consignees[selectedConsigneeIdx].name
      }
      return ''
    }
    // legacy: manual or from list
    if (legacyConsigneeMode === 'manual') return manualLegacyConsigneeName.trim()
    const found = consignees.find(c => c.id === selectedConsigneeId)
    return found?.name || ''
  }

  async function handleSave() {
    const companyName = getEffectiveCompanyName()
    const consigneeName = getEffectiveConsigneeName()

    // Validate client
    const effectiveClientName = selectedClient
      ? selectedClient.name
      : clientMode === 'manual' ? manualClientName.trim() : ''
    if (!effectiveClientName) { alert('Selecciona o ingresa el nombre del cliente.'); return }

    // Validate destination
    if (!form.to_port) { alert('Selecciona el destino (TO).'); return }

    // Validate shipper/consignee/PO
    if (selectedClient) {
      if (!companyName) { alert('Selecciona o ingresa el Shipper/Vendor.'); return }
      if (!consigneeName) { alert('Selecciona o ingresa el Consignatario.'); return }
    } else {
      const hasConsignee = legacyConsigneeMode === 'manual' ? !!manualLegacyConsigneeName.trim() : !!selectedConsigneeId
      if (!hasConsignee || !form.company_name || !form.po_number) {
        alert('Completa los campos obligatorios: Consignatario, Empresa y PO.')
        return
      }
    }
    if (!form.po_number) { alert('Ingresa el número de PO.'); return }

    setSaving(true)

    try {
      const baseData: Record<string, unknown> = {
        company_name: companyName || form.company_name,
        po_number: form.po_number,
        to_port: form.to_port,
        driver_name: form.driver_name,
        driver_license: form.driver_license,
        declared_pieces: form.declared_pieces ? parseInt(form.declared_pieces) : null,
        observations: form.observations,
        cargo_type: cargoType,
        notify_to: notifyTo,
      }

      if (selectedClient) {
        baseData.client_id = selectedClient.id
        baseData.client_name = selectedClient.name
        baseData.consignee_name = consigneeName
        baseData.consignee_id = null
      } else {
        baseData.client_name = manualClientName.trim()
        baseData.client_id = null
        baseData.consignee_id = selectedConsigneeId || null
      }

      if (isEdit) {
        let photoUrl = photoPreview && !photoFile ? photoPreview : null
        if (photoFile) photoUrl = await toBase64(photoFile)

        const updateData: Record<string, unknown> = {
          ...baseData,
          updated_at: new Date().toISOString(),
        }
        if (photoUrl) updateData.driver_license_photo_url = photoUrl
        await updateDoc(doc(db, 'warehouse_receipts', id!), updateData)
        setSavedMsg('Guardado correctamente')
        setTimeout(() => setSavedMsg(''), 3000)
      } else {
        const wrNumber = await getNextWRNumber()

        const newWRRef = await addDoc(collection(db, 'warehouse_receipts'), {
          wr_number: wrNumber,
          ...baseData,
          from_port: 'MIA',
          status: 'LOCAL',
          counter_status: 'complete',
          physical_status: 'pending',
          counter_by: user?.uid || null,
          total_qty: 0,
          total_cbm: 0,
          total_weight_kg: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })

        if (photoFile) {
          const photoUrl = await toBase64(photoFile)
          await updateDoc(newWRRef, { driver_license_photo_url: photoUrl })
        }

        navigate('/sea')
      }
    } catch (err) {
      console.error(err)
      const msg = err instanceof Error ? err.message : String(err)
      alert('Error al guardar: ' + msg)
    } finally {
      setSaving(false)
    }
  }

  const inputClass = `w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 ${isReadOnly ? 'bg-gray-50 text-gray-500 pointer-events-none' : 'bg-white'}`
  const labelClass = 'block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide'

  // Derived shipper display info (for selected client shipper)
  const selectedShipper: ClientShipper | null =
    selectedClient && selectedShipperIdx >= 0
      ? (selectedClient.shippers[selectedShipperIdx] || null)
      : null

  // Derived consignee display info
  const selectedClientConsignee: ClientConsignee | null =
    selectedClient && consigneeMode === 'select' && selectedConsigneeIdx >= 0
      ? (selectedClient.consignees[selectedConsigneeIdx] || null)
      : null

  return (
    <Layout title={isEdit ? 'Editar Recepción Documental' : 'Nueva Recepción Documental'} backTo="/sea">
      <div className="max-w-2xl mx-auto">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">

          {/* Section: Shipment Info */}
          <h2 className="text-sm font-bold text-mcl-blue uppercase tracking-wide mb-4 pb-2 border-b border-gray-100">
            Información del Envío
          </h2>
          <div className="grid grid-cols-2 gap-4 mb-6">

            {/* Client selector — FIRST field */}
            <div className="col-span-2">
              <label className={labelClass}>Cliente *</label>
              {clientMode === 'manual' ? (
                <div className="flex gap-2">
                  <input
                    className={inputClass}
                    value={manualClientName}
                    onChange={e => setManualClientName(e.target.value)}
                    placeholder="Nombre del cliente"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => { setClientMode('select'); setManualClientName(''); setSelectedClient(null) }}
                    className="text-xs text-gray-400 hover:text-gray-600 whitespace-nowrap px-2"
                  >
                    ← Lista
                  </button>
                </div>
              ) : (
                <select
                  className={inputClass}
                  value={selectedClient?.id || ''}
                  onChange={e => handleClientChange(e.target.value)}
                >
                  <option value="">Seleccionar cliente...</option>
                  {clients.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                  <option value="__manual__">Otro / Digitar nombre</option>
                </select>
              )}
            </div>

            {/* Consignee — client mode */}
            {selectedClient ? (
              <>
                <div className="col-span-2">
                  <label className={labelClass}>Consignatario *</label>
                  {consigneeMode === 'select' ? (
                    <select
                      className={inputClass}
                      value={selectedConsigneeIdx >= 0 ? String(selectedConsigneeIdx) : ''}
                      onChange={e => handleConsigneeSelectChange(e.target.value)}
                    >
                      <option value="">Seleccionar consignatario...</option>
                      {selectedClient.consignees.map((c, i) => (
                        <option key={i} value={String(i)}>{c.name}</option>
                      ))}
                      <option value="__manual__">Otro / Digitar manualmente</option>
                    </select>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        className={inputClass}
                        value={manualConsigneeName}
                        onChange={e => setManualConsigneeName(e.target.value)}
                        placeholder="Nombre del consignatario"
                      />
                      <button
                        type="button"
                        onClick={() => { setConsigneeMode('select'); setManualConsigneeName(''); setSelectedConsigneeIdx(-1) }}
                        className="text-xs text-gray-400 hover:text-gray-600 whitespace-nowrap px-2"
                      >
                        ← Lista
                      </button>
                    </div>
                  )}
                </div>
                {selectedClientConsignee?.notify_to && (
                  <div className="col-span-2">
                    <label className={labelClass}>Notify To (auto)</label>
                    <textarea
                      className={inputClass + ' bg-gray-50 text-gray-500 resize-none'}
                      rows={3}
                      value={notifyTo}
                      readOnly
                    />
                  </div>
                )}
              </>
            ) : (
              /* Legacy consignee dropdown */
              <>
                <div className="col-span-2">
                  <label className={labelClass}>Consignatario *</label>
                  {legacyConsigneeMode === 'manual' ? (
                    <div className="flex gap-2">
                      <input
                        className={inputClass}
                        value={manualLegacyConsigneeName}
                        onChange={e => setManualLegacyConsigneeName(e.target.value)}
                        placeholder="Nombre del consignatario"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => { setLegacyConsigneeMode('select'); setManualLegacyConsigneeName(''); setSelectedConsigneeId('') }}
                        className="text-xs text-gray-400 hover:text-gray-600 whitespace-nowrap px-2"
                      >
                        ← Lista
                      </button>
                    </div>
                  ) : (
                    <select
                      className={inputClass}
                      value={selectedConsigneeId}
                      onChange={e => handleLegacyConsigneeChange(e.target.value)}
                    >
                      <option value="">Seleccionar consignatario...</option>
                      {consignees.map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                      <option value="__manual__">Otro / Digitar manualmente</option>
                    </select>
                  )}
                </div>
                {notifyTo && (
                  <div className="col-span-2">
                    <label className={labelClass}>Notify To (auto)</label>
                    <textarea
                      className={inputClass + ' bg-gray-50 text-gray-500 resize-none'}
                      rows={3}
                      value={notifyTo}
                      readOnly
                    />
                  </div>
                )}
              </>
            )}

            {/* Shipper — client mode */}
            {selectedClient ? (
              <>
                <div className="col-span-2">
                  <label className={labelClass}>Shipper / Vendor *</label>
                  {shipperMode === 'select' ? (
                    <select
                      className={inputClass}
                      value={selectedShipperIdx >= 0 ? String(selectedShipperIdx) : ''}
                      onChange={e => handleShipperSelectChange(e.target.value)}
                    >
                      <option value="">Seleccionar shipper...</option>
                      {selectedClient.shippers.map((s, i) => (
                        <option key={i} value={String(i)}>{s.name}</option>
                      ))}
                      <option value="__manual__">Otro / Digitar manualmente</option>
                    </select>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        className={inputClass}
                        value={manualShipperName}
                        onChange={e => { setManualShipperName(e.target.value); set('company_name', e.target.value) }}
                        placeholder="Nombre del shipper"
                      />
                      <button
                        type="button"
                        onClick={() => { setShipperMode('select'); setManualShipperName(''); setSelectedShipperIdx(-1); set('company_name', '') }}
                        className="text-xs text-gray-400 hover:text-gray-600 whitespace-nowrap px-2"
                      >
                        ← Lista
                      </button>
                    </div>
                  )}
                </div>
                {selectedShipper && (
                  <div className="col-span-2">
                    <label className={labelClass}>Información del Shipper (auto)</label>
                    <textarea
                      className={inputClass + ' bg-gray-50 text-gray-500 resize-none'}
                      rows={2}
                      readOnly
                      value={[selectedShipper.address, selectedShipper.city, selectedShipper.province, selectedShipper.country, selectedShipper.zip].filter(Boolean).join(', ')}
                    />
                  </div>
                )}
              </>
            ) : (
              /* Legacy vendor dropdown replaced by free text for backward compat — keep as input */
              <div className="col-span-2">
                <label className={labelClass}>Shipper / Vendor *</label>
                <input
                  className={inputClass}
                  value={form.company_name}
                  onChange={e => set('company_name', e.target.value)}
                  placeholder="Nombre del shipper/vendor"
                />
              </div>
            )}

            <div>
              <label className={labelClass}>N° PO (Airwaybill) *</label>
              <input className={inputClass} value={form.po_number} onChange={e => set('po_number', e.target.value)} placeholder="PO-4749800" />
            </div>
            <div>
              <label className={labelClass}>Tipo de Carga</label>
              <div className="flex rounded-lg overflow-hidden border border-gray-200 h-[42px]">
                <button
                  type="button"
                  onClick={() => !isReadOnly && setCargoType('LOC')}
                  disabled={isReadOnly}
                  className={`flex-1 text-sm font-bold transition-colors ${cargoType === 'LOC' ? 'bg-mcl-blue text-white' : 'bg-white text-gray-400 hover:bg-gray-50'} ${isReadOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
                >
                  LOC
                </button>
                <button
                  type="button"
                  onClick={() => !isReadOnly && setCargoType('BOND')}
                  disabled={isReadOnly}
                  className={`flex-1 text-sm font-bold transition-colors border-l border-gray-200 ${cargoType === 'BOND' ? 'bg-amber-500 text-white' : 'bg-white text-gray-400 hover:bg-gray-50'} ${isReadOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
                >
                  BOND
                </button>
              </div>
            </div>
            <div>
              <label className={labelClass}>Destino (TO) *</label>
              <select className={inputClass} value={form.to_port} onChange={e => set('to_port', e.target.value)}>
                <option value="">Seleccionar...</option>
                {SEA_DESTINATIONS.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Piezas Declaradas</label>
              <input className={inputClass} type="number" value={form.declared_pieces} onChange={e => set('declared_pieces', e.target.value)} placeholder="0" />
            </div>
            <div className="col-span-2">
              <label className={labelClass}>Observaciones</label>
              <textarea className={inputClass} rows={2} value={form.observations} onChange={e => set('observations', e.target.value)} placeholder="Notas adicionales..." />
            </div>
          </div>

          {/* Section: Driver */}
          <h2 className="text-sm font-bold text-mcl-blue uppercase tracking-wide mb-4 pb-2 border-b border-gray-100">
            Información del Driver
          </h2>
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div>
              <label className={labelClass}>Nombre del Driver</label>
              <input className={inputClass} value={form.driver_name} onChange={e => set('driver_name', e.target.value)} placeholder="John Smith" />
            </div>
            <div>
              <label className={labelClass}>Driver License #</label>
              <input className={inputClass} value={form.driver_license} onChange={e => set('driver_license', e.target.value)} placeholder="D1234567" />
            </div>
            <div className="col-span-2">
              <label className={labelClass}>Foto del Driver License</label>
              <div className="flex items-start gap-4">
                <button
                  type="button"
                  onClick={() => !isReadOnly && photoInputRef.current?.click()}
                  disabled={isReadOnly}
                  className={`flex items-center gap-2 border-2 border-dashed border-gray-300 rounded-lg px-4 py-3 text-sm text-gray-500 hover:border-mcl-blue hover:text-mcl-blue transition-colors ${isReadOnly ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Tomar / Subir Foto
                </button>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhoto}
                  className="hidden"
                />
                {photoPreview && (
                  <img src={photoPreview} alt="DL Preview" className="h-20 w-32 object-cover rounded-lg border border-gray-200" />
                )}
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="pt-4 border-t border-gray-100">
            {savedMsg && (
              <div className="mb-3 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-700 text-center">
                {savedMsg}
              </div>
            )}

            {isReadOnly ? (
              /* Read-only mode: only show "Abrir" button */
              canOpenEdit && (
                <button
                  onClick={() => setViewMode(false)}
                  className="w-full bg-mcl-blue text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors"
                >
                  Abrir
                </button>
              )
            ) : isEdit ? (
              /* Edit mode (existing WR): "Guardar" + "Editar WR" */
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={() => handleSave()}
                  disabled={saving}
                  className="flex-1 bg-mcl-blue text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors disabled:opacity-50"
                >
                  {saving ? 'Guardando...' : 'Guardar'}
                </button>
                <button
                  onClick={() => canEditWR && navigate(`/reception/${id}`)}
                  disabled={!canEditWR}
                  className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                    canEditWR
                      ? 'bg-orange-500 text-white hover:bg-orange-600'
                      : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  }`}
                  title={!canEditWR ? 'Solo Admin y Super Agent pueden editar el WR' : ''}
                >
                  Editar WR
                </button>
              </div>
            ) : (
              /* New WR: single save button */
              <button
                onClick={() => handleSave()}
                disabled={saving}
                className="w-full bg-mcl-blue text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors disabled:opacity-50"
              >
                {saving ? 'Guardando...' : 'Guardar'}
              </button>
            )}
          </div>
        </div>
      </div>
    </Layout>
  )
}
