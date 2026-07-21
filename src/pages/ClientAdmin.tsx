import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Layout from '../components/Layout'
import { db } from '../lib/firebase'
import { collection, getDocs, getDoc, addDoc, updateDoc, deleteDoc, doc, orderBy, query, where } from 'firebase/firestore'
import { Client, ClientShipper, ClientConsignee, ClientEmailRecipient, BillingProfile } from '../types'
import { CLIENT_SEED_DATA } from '../data/clientSeedData'

export default function ClientAdmin() {
  const { id } = useParams()
  const isForm = window.location.pathname.includes('/new') || !!id

  return isForm ? <ClientForm id={id} /> : <ClientList />
}

function ClientList() {
  const navigate = useNavigate()
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [seeding, setSeeding] = useState(false)

  useEffect(() => { loadClients() }, [])

  async function loadClients() {
    const snap = await getDocs(query(collection(db, 'clients'), orderBy('name')))
    setClients(snap.docs.map(d => ({ id: d.id, ...d.data() })) as Client[])
    setLoading(false)
  }

  async function handleSeed() {
    if (!confirm(`¿Cargar ${CLIENT_SEED_DATA.length} clientes predeterminados? Esto creará registros nuevos.`)) return
    setSeeding(true)
    try {
      for (const clientData of CLIENT_SEED_DATA) {
        await addDoc(collection(db, 'clients'), clientData)
      }
      await loadClients()
    } catch (e) {
      alert('Error al cargar datos: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSeeding(false)
    }
  }

  async function handleDelete(client: Client) {
    if (!confirm(`¿Eliminar cliente "${client.name}"?`)) return
    await deleteDoc(doc(db, 'clients', client.id!))
    setClients(prev => prev.filter(c => c.id !== client.id))
  }

  return (
    <Layout title="Shippers/Consignees Clientes" backTo="/billing">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-end gap-2 mb-4">
          {clients.length === 0 && (
            <button
              onClick={handleSeed}
              disabled={seeding}
              className="bg-amber-500 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-amber-600 transition-colors disabled:opacity-50"
            >
              {seeding ? 'Cargando...' : 'Cargar Clientes Base'}
            </button>
          )}
          <button
            onClick={() => navigate('/clients/new')}
            className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors"
          >
            + Nuevo Cliente
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center p-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div>
        ) : clients.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400">
            No hay clientes aún. Crea el primero.
          </div>
        ) : (
          <div className="space-y-3">
            {clients.map(c => (
              <div key={c.id} className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex items-center justify-between">
                <div>
                  <p className="font-semibold text-gray-800">{c.name}</p>
                  <div className="flex gap-3 mt-1 text-xs text-gray-400">
                    <span>{c.shippers?.length || 0} shippers</span>
                    <span>{c.consignees?.length || 0} consignatarios</span>
                    <span>{c.email_recipients?.length || 0} emails</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => navigate(`/clients/${c.id}/edit`)}
                    className="text-xs bg-blue-50 text-mcl-blue border border-blue-200 px-3 py-1.5 rounded-lg hover:bg-blue-100 transition-colors"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => handleDelete(c)}
                    className="text-xs bg-red-50 text-red-600 border border-red-200 px-3 py-1.5 rounded-lg hover:bg-red-100 transition-colors"
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  )
}

function ClientForm({ id }: { id?: string }) {
  const navigate = useNavigate()
  const isEdit = !!id
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [name, setName] = useState('')
  const [emailRecipients, setEmailRecipients] = useState<ClientEmailRecipient[]>([{ name: '', email: '', destination: '', notify_wr: false, notify_gate_out: false, notify_docs: false }])
  const [shippers, setShippers] = useState<ClientShipper[]>([{ name: '', address: '', city: '', province: '', country: 'US', zip: '' }])
  const [consignees, setConsignees] = useState<ClientConsignee[]>([{ name: '', full_address: '', notify_to: '' }])

  useEffect(() => { if (isEdit) loadClient() }, [id])

  async function loadClient() {
    const snap = await getDoc(doc(db, 'clients', id!))
    if (snap.exists()) {
      const data = snap.data() as Client
      setName(data.name || '')
      setEmailRecipients(data.email_recipients?.length ? data.email_recipients : [{ name: '', email: '', destination: '', notify_wr: false, notify_gate_out: false, notify_docs: false }])
      setShippers(data.shippers?.length ? data.shippers : [{ name: '', address: '', city: '', province: '', country: 'US', zip: '' }])
      setConsignees(data.consignees?.length ? data.consignees : [{ name: '', full_address: '', notify_to: '' }])
    }
  }

  async function importFromBilling() {
    if (!name.trim()) { alert('Primero ingresa el nombre del cliente.'); return }
    setImporting(true)
    try {
      const bpSnap = await getDocs(query(collection(db, 'billing_profiles'), where('client_name', '==', name.trim())))
      if (bpSnap.empty) { alert('No se encontraron perfiles de billing para este cliente.'); setImporting(false); return }
      const imported: ClientEmailRecipient[] = []
      for (const d of bpSnap.docs) {
        const bp = d.data() as BillingProfile
        const dests = bp.destinations?.length ? bp.destinations : ['']
        for (const contact of bp.contacts || []) {
          if (!contact.email?.trim()) continue
          for (const dest of dests) {
            imported.push({
              name: contact.name || '',
              email: contact.email,
              destination: dest,
              notify_wr: (contact as any).notify_wr ?? false,
              notify_gate_out: (contact as any).notify_dispatch ?? false,
              notify_docs: false,
            })
          }
        }
      }
      if (imported.length === 0) { alert('Los perfiles de billing no tienen contactos con email.'); setImporting(false); return }
      // Deduplicate by email+destination
      const seen = new Set<string>()
      const deduped = imported.filter(r => {
        const key = `${r.email}::${r.destination}`
        if (seen.has(key)) return false
        seen.add(key); return true
      })
      setEmailRecipients(deduped)
      alert(`Importados ${deduped.length} contactos de ${bpSnap.size} perfil(es) de billing.`)
    } catch (e) {
      alert('Error: ' + (e instanceof Error ? e.message : String(e)))
    }
    setImporting(false)
  }

  async function handleSave() {
    if (!name.trim()) { alert('Ingresa el nombre del cliente.'); return }
    setSaving(true)
    try {
      const data = {
        name: name.trim(),
        email_recipients: emailRecipients.filter(r => r.email.trim()),
        shippers: shippers.filter(s => s.name.trim()),
        consignees: consignees.filter(c => c.name.trim()),
      }
      if (isEdit) {
        await updateDoc(doc(db, 'clients', id!), { ...data, updated_at: new Date().toISOString() })
      } else {
        await addDoc(collection(db, 'clients'), { ...data, created_at: new Date().toISOString() })
      }
      navigate('/clients')
    } catch (e) {
      alert('Error al guardar: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSaving(false)
    }
  }

  const DEST_LABELS: Record<string, string> = { EZE: 'ARG', GRU: 'BRA', MVD: 'URU' }
  const destLabel = (code: string) => DEST_LABELS[code] || code

  const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30'
  const labelClass = 'block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide'

  return (
    <Layout title={isEdit ? 'Editar Cliente' : 'Nuevo Cliente'} backTo="/clients">
      <div className="max-w-2xl mx-auto space-y-6">

        {/* Basic info */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-sm font-bold text-mcl-blue uppercase tracking-wide mb-4 pb-2 border-b border-gray-100">Datos del Cliente</h2>
          <label className={labelClass}>Nombre del Cliente *</label>
          <input className={inputClass} value={name} onChange={e => setName(e.target.value)} placeholder="Ej. Sodimac" />
        </div>

        {/* Email recipients grouped by destination */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-100">
            <h2 className="text-sm font-bold text-mcl-blue uppercase tracking-wide">Destinatarios de Mail</h2>
            <div className="flex gap-2">
            <button onClick={importFromBilling} disabled={importing}
              className="text-xs bg-amber-500 text-white px-2 py-1 rounded hover:bg-amber-600 disabled:opacity-50">
              {importing ? 'Importando...' : 'Importar de Billing'}
            </button>
            <button onClick={() => {
              const dest = prompt('Nombre del destino (ej: SCL, BOG) o dejar vacío para "All":')
              if (dest === null) return
              setEmailRecipients(prev => [...prev, { name: '', email: '', destination: dest.trim().toUpperCase(), notify_wr: false, notify_gate_out: false, notify_docs: false }])
            }} className="text-xs bg-mcl-blue text-white px-2 py-1 rounded hover:bg-blue-900">+ Agregar Grupo de Destino</button>
            </div>
          </div>
          {(() => {
            const groups = new Map<string, { indices: number[] }>()
            emailRecipients.forEach((r, i) => {
              const key = r.destination || ''
              if (!groups.has(key)) groups.set(key, { indices: [] })
              groups.get(key)!.indices.push(i)
            })
            const sorted = [...groups.entries()].sort(([a], [b]) => {
              if (a === '') return -1
              if (b === '') return 1
              return a.localeCompare(b)
            })
            return sorted.map(([dest, { indices }]) => (
              <div key={dest} className="mb-4 last:mb-0">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-gray-700 uppercase tracking-wide">{dest ? destLabel(dest) : 'All (todos los destinos)'}</span>
                  <button onClick={() => setEmailRecipients(prev => [...prev, { name: '', email: '', destination: dest, notify_wr: false, notify_gate_out: false, notify_docs: false }])}
                    className="text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded hover:bg-gray-200">+ Add</button>
                </div>
                <div className="border border-gray-100 rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50 text-gray-500 uppercase text-[10px]">
                        <th className="text-left px-2 py-1.5 font-semibold">Contacto</th>
                        <th className="text-left px-2 py-1.5 font-semibold">Email</th>
                        <th className="px-2 py-1.5 font-semibold w-10 text-center">WR</th>
                        <th className="px-2 py-1.5 font-semibold w-10 text-center">Docs</th>
                        <th className="px-2 py-1.5 font-semibold w-10 text-center">Gate</th>
                        <th className="w-8"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {indices.map(i => {
                        const r = emailRecipients[i]
                        return (
                          <tr key={i} className="border-t border-gray-50">
                            <td className="px-2 py-1.5">
                              <input className="w-full border border-gray-200 rounded px-2 py-1 text-xs" value={r.name}
                                onChange={e => setEmailRecipients(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="Nombre" />
                            </td>
                            <td className="px-2 py-1.5">
                              <input className="w-full border border-gray-200 rounded px-2 py-1 text-xs" value={r.email} type="email"
                                onChange={e => setEmailRecipients(prev => prev.map((x, j) => j === i ? { ...x, email: e.target.value } : x))} placeholder="email@ejemplo.com" />
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              <input type="checkbox" checked={r.notify_wr ?? false}
                                onChange={e => setEmailRecipients(prev => prev.map((x, j) => j === i ? { ...x, notify_wr: e.target.checked } : x))}
                                className="rounded border-gray-300 text-mcl-blue w-3.5 h-3.5" />
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              <input type="checkbox" checked={r.notify_docs ?? false}
                                onChange={e => setEmailRecipients(prev => prev.map((x, j) => j === i ? { ...x, notify_docs: e.target.checked } : x))}
                                className="rounded border-gray-300 text-mcl-blue w-3.5 h-3.5" />
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              <input type="checkbox" checked={r.notify_gate_out ?? false}
                                onChange={e => setEmailRecipients(prev => prev.map((x, j) => j === i ? { ...x, notify_gate_out: e.target.checked } : x))}
                                className="rounded border-gray-300 text-mcl-blue w-3.5 h-3.5" />
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              <button onClick={() => setEmailRecipients(prev => prev.filter((_, j) => j !== i))}
                                className="text-red-400 hover:text-red-600">x</button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          })()}
        </div>

        {/* Shippers */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-100">
            <h2 className="text-sm font-bold text-mcl-blue uppercase tracking-wide">Shippers / Vendors</h2>
            <button onClick={() => setShippers(prev => [...prev, { name: '', address: '', city: '', province: '', country: 'US', zip: '' }])} className="text-xs bg-mcl-blue text-white px-2 py-1 rounded hover:bg-blue-900">+ Agregar</button>
          </div>
          <div className="space-y-4">
            {shippers.map((s, i) => (
              <div key={i} className="border border-gray-100 rounded-lg p-3 relative">
                {shippers.length > 1 && (
                  <button onClick={() => setShippers(prev => prev.filter((_, j) => j !== i))} className="absolute top-2 right-2 text-red-400 hover:text-red-600 text-sm">×</button>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div className="col-span-2"><label className={labelClass}>Nombre *</label><input className={inputClass} value={s.name} onChange={e => setShippers(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="Nombre del shipper" /></div>
                  <div className="col-span-2"><label className={labelClass}>Dirección</label><input className={inputClass} value={s.address || ''} onChange={e => setShippers(prev => prev.map((x, j) => j === i ? { ...x, address: e.target.value } : x))} /></div>
                  <div><label className={labelClass}>Ciudad</label><input className={inputClass} value={s.city || ''} onChange={e => setShippers(prev => prev.map((x, j) => j === i ? { ...x, city: e.target.value } : x))} /></div>
                  <div><label className={labelClass}>Estado/Prov</label><input className={inputClass} value={s.province || ''} onChange={e => setShippers(prev => prev.map((x, j) => j === i ? { ...x, province: e.target.value } : x))} /></div>
                  <div><label className={labelClass}>País</label><input className={inputClass} value={s.country || ''} onChange={e => setShippers(prev => prev.map((x, j) => j === i ? { ...x, country: e.target.value } : x))} /></div>
                  <div><label className={labelClass}>ZIP</label><input className={inputClass} value={s.zip || ''} onChange={e => setShippers(prev => prev.map((x, j) => j === i ? { ...x, zip: e.target.value } : x))} /></div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Consignees */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-100">
            <h2 className="text-sm font-bold text-mcl-blue uppercase tracking-wide">Consignatarios</h2>
            <button onClick={() => setConsignees(prev => [...prev, { name: '', full_address: '', notify_to: '' }])} className="text-xs bg-mcl-blue text-white px-2 py-1 rounded hover:bg-blue-900">+ Agregar</button>
          </div>
          <div className="space-y-4">
            {consignees.map((c, i) => (
              <div key={i} className="border border-gray-100 rounded-lg p-3 relative">
                {consignees.length > 1 && (
                  <button onClick={() => setConsignees(prev => prev.filter((_, j) => j !== i))} className="absolute top-2 right-2 text-red-400 hover:text-red-600 text-sm">×</button>
                )}
                <div className="space-y-2">
                  <div><label className={labelClass}>Nombre *</label><input className={inputClass} value={c.name} onChange={e => setConsignees(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="Nombre del consignatario" /></div>
                  <div><label className={labelClass}>Dirección completa</label><textarea className={inputClass + ' resize-none'} rows={2} value={c.full_address || ''} onChange={e => setConsignees(prev => prev.map((x, j) => j === i ? { ...x, full_address: e.target.value } : x))} /></div>
                  <div><label className={labelClass}>Notify To</label><textarea className={inputClass + ' resize-none'} rows={2} value={c.notify_to || ''} onChange={e => setConsignees(prev => prev.map((x, j) => j === i ? { ...x, notify_to: e.target.value } : x))} /></div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 pb-6">
          <button onClick={() => navigate('/clients')} className="flex-1 border border-gray-300 text-gray-700 px-4 py-2.5 rounded-lg text-sm hover:bg-gray-50">
            Cancelar
          </button>
          <button onClick={handleSave} disabled={saving} className="flex-1 bg-mcl-blue text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-blue-900 disabled:opacity-50">
            {saving ? 'Guardando...' : isEdit ? 'Guardar Cambios' : 'Crear Cliente'}
          </button>
        </div>
      </div>
    </Layout>
  )
}
