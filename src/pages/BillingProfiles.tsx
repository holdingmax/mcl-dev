import { useState, useEffect } from 'react'
import {
  collection, query, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, doc,
  getDocs, getDoc, setDoc,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { BillingProfile, BillingProfileContact, Client, EmailSettingsCC } from '../types'
import Layout from '../components/Layout'
import { SEA_DESTINATIONS } from '../types'

interface ConsigneeDoc {
  id: string
  name: string
  full_address: string
  notify_to: string
}

const EMPTY_CONTACT: BillingProfileContact = { name: '', role: '', phone: '', email: '', active: true }

const TERMS_DAYS_OPTIONS = [15, 30, 45, 60]

const SODIMAC_SEED: Omit<BillingProfile, 'id' | 'client_id' | 'client_name' | 'created_at'>[] = [
  {
    customer_name: 'Sodimac Chile',
    destinations: ['SCL'],
    notify_to: 'SODIMAC S.A.\nRUT: 96792430-K\nAV. PDTE. EDO. FREI M. 3092\nRENCA - SANTIAGO - CHILE\nPHONE: +56 2 2738 1000\n_ComexSodimac@Falabella.cl',
    payment_terms_days: 15,
    payment_terms_from: 'invoice',
    contacts: [
      { name: 'Paola Moran', role: 'Dest Customer Support', phone: '56 2 27381411', email: 'pmoran@sodimac.cl' },
      { name: 'Comex', role: 'Dest Customer Analyst', phone: '56 2 27381411', email: '_comexsodimac@falabella.cl' },
    ],
    observations: '',
    active: true,
  },
  {
    customer_name: 'TIENDAS DEL MEJORAMIENTO DEL HOGAR S.A.',
    destinations: ['LIM'],
    notify_to: 'TIENDAS DEL MEJORAMIENTO DEL HOGAR S.A.\nAvenida Angamos Este N° 1805, Interior 2,\noficina 2, distrito de Surquillo – Lima - Perú\nRUC: 20112273922\nPhone: 511- 2119500\nFax: 511- 6110418',
    payment_terms_days: 15,
    payment_terms_from: 'invoice',
    contacts: [
      { name: 'Jessica Perea', role: 'Dest Customer Support', phone: '511 2119500', email: 'jpereas@sodimac.com.pe' },
      { name: 'Comex', role: 'Dest Customer Analyst', phone: '511 2119500', email: 'ImportacionesPeru@Falabella.cl' },
    ],
    observations: '',
    active: true,
  },
  {
    customer_name: 'Sodimac Colombia',
    destinations: ['BOG'],
    notify_to: 'SODIMAC COLOMBIA S.A.\nNIT 800.242.106-2\nCRA 68D NO. 80-70 TEL: 4578100\nMERCANCIA EN TRANSITO ADUANERO\nDEPOSITO REPREMUNDO: 00502 NIT 860079024-7\nKM2 AUTOPISTA MEDELLIN, CELTA TRADE PARK,\nVEREDA LA ISLA, FUNZA BOGOTA - COLOMBIA',
    payment_terms_days: 15,
    payment_terms_from: 'invoice',
    contacts: [
      { name: 'Claudia Maldonado', role: 'Dest Customer Support', phone: '57 18 773456', email: 'cmaldonado@homecenter.co' },
      { name: 'Andrea Gonzalez', role: 'Dest Customer Analyst', phone: '57 18 773456', email: 'agonzalezr@homecenter.co' },
    ],
    observations: '',
    active: true,
  },
  {
    customer_name: 'Sodimac Argentina y Uruguay',
    destinations: ['EZE', 'MVD'],
    notify_to: 'HOMECENTER SODIMAC S.A.\nRUT: 216996650015\nARIZONA 865\nBARRA DE CARRASCO\nCIUDAD DE LA COSTA,\n(CP 15000) CANELONES – URUGUAY\nPhone: +598 2484 5089',
    payment_terms_days: 15,
    payment_terms_from: 'invoice',
    contacts: [
      { name: 'Laura Bozo', role: 'Dest Customer Support', phone: '54 911 40224647', email: 'lboso@sodimac.com.ar' },
      { name: 'Comex', role: 'Dest Customer Analyst', phone: '54 911 40224647', email: '_ComexArgentina@Falabella.c' },
    ],
    observations: '',
    active: true,
  },
  {
    customer_name: 'Sodimac Brazil (DICICO)',
    destinations: ['GRU'],
    notify_to: 'CONSTRUDECOR S/A\nAVENIDA SANTOS DUMONT, 4475\nARMAZEM 3\nJARDIM CONCEICAOZINHA (VICENTE DE CARVALHO)\nGUARUJA – SP – BRASIL\nCEP: 11460-006\nCNPJ.: 03.439.316/0038-64\nPhone: +5511 2065-2525 - Fax: +5511 2065-2500',
    payment_terms_days: 15,
    payment_terms_from: 'invoice',
    contacts: [
      { name: 'Fabio Bernardino', role: 'Dest Customer Support', phone: '55 112 652525', email: 'fbernardino@sodimac.com.br' },
      { name: 'Leticia Mendanha', role: 'Dest Customer Support', phone: '55 112 652525', email: 'lmendanha@sodimac.com.br' },
      { name: 'Marina Espada', role: 'Dest Customer Support', phone: '55 112 652525', email: 'mespada@sodimac.com.br' },
    ],
    observations: '',
    active: true,
  },
  {
    customer_name: 'Sodimac Mexico',
    destinations: [],
    notify_to: 'Comercializadora SDMHC, SA DE CV\nRFC CSD161207R2A\nAv. Adolfo Lopez Mateos No. 201 Col Santa\nCruz Acatlan CP. 53150 Naucalpan de\nJuarez, Estado de Mexico\nPhone: +52 (55) 5375 9000 ext. 9341, 9381, 9382\ncomex.mex@sodimac.com.mx',
    payment_terms_days: 15,
    payment_terms_from: 'invoice',
    contacts: [
      { name: 'Lucia Perez', role: 'Management', phone: '+52 (55) 1516-4400 ext 2000462', email: 'lperezg@sodimac.com.mx' },
      { name: 'Comex', role: 'Dest Customer Analyst', phone: '52 (55) 1516 4400 ext 2000483', email: 'comex.mex@Sodimac.com.mx' },
    ],
    observations: '',
    active: true,
  },
]

export default function BillingProfiles() {
  const [profiles, setProfiles] = useState<(BillingProfile & { id: string })[]>([])
  const [clients, setClients] = useState<(Client & { id: string })[]>([])
  const [consignees, setConsignees] = useState<ConsigneeDoc[]>([])
  const [loading, setLoading] = useState(true)

  // Form
  const [editing, setEditing] = useState<(BillingProfile & { id?: string }) | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Delete
  const [confirmDelete, setConfirmDelete] = useState<(BillingProfile & { id: string }) | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Seed
  const [seeding, setSeeding] = useState(false)

  // Filter
  const [filterClient, setFilterClient] = useState('')
  const [search, setSearch] = useState('')

  // MCL CC recipients (global config)
  const [ccRecipients, setCcRecipients] = useState<EmailSettingsCC[]>([])
  const [showCcEditor, setShowCcEditor] = useState(false)
  const [savingCc, setSavingCc] = useState(false)

  useEffect(() => {
    const unsubProfiles = onSnapshot(
      query(collection(db, 'billing_profiles'), orderBy('client_name')),
      snap => {
        setProfiles(snap.docs.map(d => ({ ...d.data() as BillingProfile, id: d.id })))
        setLoading(false)
      }
    )
    // Load clients and consignees once
    getDocs(query(collection(db, 'clients'), orderBy('name'))).then(snap => {
      setClients(snap.docs.map(d => ({ ...d.data() as Client, id: d.id })))
    })
    getDocs(query(collection(db, 'consignees'), orderBy('name'))).then(snap => {
      setConsignees(snap.docs.map(d => ({ ...d.data() as ConsigneeDoc, id: d.id })))
    })
    // Load CC config
    getDoc(doc(db, 'config', 'email_settings')).then(snap => {
      if (snap.exists()) {
        setCcRecipients(snap.data().mcl_cc_recipients || [])
      }
    })
    return () => unsubProfiles()
  }, [])

  async function saveCcRecipients() {
    setSavingCc(true)
    try {
      await setDoc(doc(db, 'config', 'email_settings'), { mcl_cc_recipients: ccRecipients }, { merge: true })
    } catch (e) { alert('Error: ' + (e instanceof Error ? e.message : String(e))) }
    setSavingCc(false)
    setShowCcEditor(false)
  }

  // ── Seed Sodimac ────────────────────────────────────────────
  async function seedSodimac() {
    const sodimacClient = clients.find(c => c.name.toLowerCase().includes('sodimac'))
    if (!sodimacClient) { alert('No se encontró el cliente Sodimac en el catálogo de clientes.'); return }
    if (!confirm(`Cargar 6 perfiles de Sodimac (${sodimacClient.name})?`)) return
    setSeeding(true)
    try {
      const now = new Date().toISOString()
      for (const seed of SODIMAC_SEED) {
        await addDoc(collection(db, 'billing_profiles'), {
          ...seed,
          client_id: sodimacClient.id,
          client_name: sodimacClient.name,
          created_at: now,
        })
      }
    } catch (e) { console.error(e); alert('Error al cargar: ' + String(e)) }
    setSeeding(false)
  }

  // ── Filtered ───────────────────────────────────────────────
  const filtered = profiles.filter(p => {
    if (filterClient && p.client_name !== filterClient) return false
    if (search) {
      const s = search.toLowerCase()
      return p.client_name.toLowerCase().includes(s) ||
        p.customer_name.toLowerCase().includes(s) ||
        p.destinations.some(d => d.toLowerCase().includes(s)) ||
        p.contacts.some(c => c.name.toLowerCase().includes(s) || c.email.toLowerCase().includes(s))
    }
    return true
  })

  const clientOptions = [...new Set(profiles.map(p => p.client_name))].sort()

  // ── Form helpers ───────────────────────────────────────────
  function openNew() {
    setEditing({
      client_id: '',
      client_name: '',
      customer_name: '',
      destinations: [],
      notify_to: '',
      payment_terms_days: 15,
      payment_terms_from: 'invoice',
      contacts: [{ ...EMPTY_CONTACT }],
      observations: '',
      active: true,
    })
    setError('')
  }

  function openEdit(p: BillingProfile & { id: string }) {
    setEditing({
      ...p,
      contacts: p.contacts.length > 0 ? p.contacts.map(c => ({ ...c })) : [{ ...EMPTY_CONTACT }],
    })
    setError('')
  }

  function selectClient(clientId: string) {
    if (!editing) return
    const client = clients.find(c => c.id === clientId)
    setEditing({ ...editing, client_id: clientId, client_name: client?.name || '' })
  }

  function selectConsignee(consigneeId: string) {
    if (!editing) return
    const con = consignees.find(c => c.id === consigneeId)
    if (con) {
      setEditing({
        ...editing,
        customer_name: con.name,
        notify_to: `${con.name}\n${con.notify_to}`,
      })
    }
  }

  function toggleDestination(dest: string) {
    if (!editing) return
    const dests = editing.destinations.includes(dest)
      ? editing.destinations.filter(d => d !== dest)
      : [...editing.destinations, dest]
    setEditing({ ...editing, destinations: dests })
  }

  function updateContact(idx: number, field: keyof BillingProfileContact, value: string | boolean) {
    if (!editing) return
    const contacts = [...editing.contacts]
    contacts[idx] = { ...contacts[idx], [field]: value }
    setEditing({ ...editing, contacts })
  }

  function addContact() {
    if (!editing) return
    setEditing({ ...editing, contacts: [...editing.contacts, { ...EMPTY_CONTACT }] })
  }

  function removeContact(idx: number) {
    if (!editing) return
    setEditing({ ...editing, contacts: editing.contacts.filter((_, i) => i !== idx) })
  }

  async function handleSave() {
    if (!editing) return
    if (!editing.client_id) { setError('Selecciona un cliente'); return }
    if (!editing.customer_name.trim()) { setError('El customer es requerido'); return }
    if (editing.destinations.length === 0) { setError('Selecciona al menos un destino'); return }
    setSaving(true); setError('')
    try {
      const data = {
        client_id: editing.client_id,
        client_name: editing.client_name,
        customer_name: editing.customer_name.trim(),
        destinations: editing.destinations,
        notify_to: editing.notify_to.trim(),
        payment_terms_days: editing.payment_terms_days,
        payment_terms_from: editing.payment_terms_from,
        contacts: editing.contacts.filter(c => c.email.trim() || c.name.trim()),
        observations: editing.observations.trim(),
        active: editing.active,
        created_at: (editing as any).created_at || new Date().toISOString(),
      }
      if (editing.id) {
        await updateDoc(doc(db, 'billing_profiles', editing.id), data)
      } else {
        await addDoc(collection(db, 'billing_profiles'), data)
      }
      setEditing(null)
    } catch { setError('Error al guardar') }
    finally { setSaving(false) }
  }

  async function handleDelete() {
    if (!confirmDelete) return
    setDeleting(true)
    try {
      await deleteDoc(doc(db, 'billing_profiles', confirmDelete.id))
      setConfirmDelete(null)
    } catch (err) { console.error(err) }
    setDeleting(false)
  }

  // ── Render ─────────────────────────────────────────────────
  return (
    <Layout title="Perfiles de Facturación" backTo="/billing">
      <div className="max-w-4xl mx-auto space-y-5">

        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por cliente, customer, destino, contacto..."
            className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
          <select value={filterClient} onChange={e => setFilterClient(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
            <option value="">Todos los clientes</option>
            {clientOptions.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          {profiles.length === 0 && clients.length > 0 && (
            <button onClick={seedSodimac} disabled={seeding}
              className="bg-amber-500 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-amber-600 transition-colors whitespace-nowrap disabled:opacity-50">
              {seeding ? 'Cargando...' : 'Cargar Sodimac'}
            </button>
          )}
          <button onClick={openNew}
            className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors whitespace-nowrap">
            + Nuevo Perfil
          </button>
          <button onClick={() => setShowCcEditor(true)}
            className="border border-gray-200 text-gray-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors whitespace-nowrap">
            CC Internos MCL
          </button>
        </div>

        {/* List */}
        {loading ? (
          <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400">
            {profiles.length === 0 ? 'No hay perfiles de facturación.' : 'Sin resultados para los filtros.'}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(p => (
              <div key={p.id} className={`bg-white rounded-xl border shadow-sm overflow-hidden ${!p.active ? 'opacity-60 border-gray-100' : 'border-gray-200'}`}>
                <div className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      {/* Header */}
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-semibold text-gray-800">{p.client_name}</span>
                        <span className="text-gray-300">|</span>
                        <span className="text-sm text-gray-600">{p.customer_name}</span>
                      </div>
                      {/* Destinations */}
                      <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                        {p.destinations.map(d => (
                          <span key={d} className="text-xs font-bold bg-blue-100 text-blue-700 px-2 py-0.5 rounded">{d}</span>
                        ))}
                        <span className="text-xs text-gray-400 ml-1">
                          N{p.payment_terms_days} — {p.payment_terms_from === 'service' ? 'desde servicio' : 'desde facturación'}
                        </span>
                      </div>
                      {/* Notify preview */}
                      <p className="text-xs text-gray-400 line-clamp-2 whitespace-pre-line">{p.notify_to}</p>
                      {/* Contacts */}
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-2">
                        {p.contacts.map((c, i) => (
                          <span key={i} className="text-xs text-gray-500">
                            {c.name} <span className="text-gray-300">({c.email})</span>
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => openEdit(p)} className="text-xs text-mcl-blue hover:underline">Editar</button>
                      <button onClick={() => setConfirmDelete(p)} className="text-xs text-gray-400 hover:text-red-500">Eliminar</button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-gray-300 text-center">{filtered.length} perfil{filtered.length !== 1 ? 'es' : ''}</p>
      </div>

      {/* ── Edit/Create Modal ── */}
      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 space-y-4">
              <h3 className="text-lg font-semibold text-gray-800">
                {editing.id ? 'Editar Perfil de Facturación' : 'Nuevo Perfil de Facturación'}
              </h3>

              {error && <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">{error}</div>}

              {/* Cliente */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Cliente *</label>
                <select value={editing.client_id} onChange={e => selectClient(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                  <option value="">— Seleccionar cliente —</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>

              {/* Customer / Consignatario */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Customer (Consignatario) *</label>
                <div className="flex gap-2">
                  <input value={editing.customer_name}
                    onChange={e => setEditing({ ...editing, customer_name: e.target.value })}
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Ej: Sodimac Chile" />
                  <select onChange={e => { if (e.target.value) selectConsignee(e.target.value); e.target.value = '' }}
                    className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-500 w-48 shrink-0">
                    <option value="">Pre-llenar de...</option>
                    {consignees.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </div>

              {/* Destinos */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Pais-Destino *</label>
                <div className="flex flex-wrap gap-2">
                  {SEA_DESTINATIONS.map(d => (
                    <button key={d} type="button" onClick={() => toggleDestination(d)}
                      className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-all ${
                        editing.destinations.includes(d)
                          ? 'border-mcl-blue bg-mcl-blue/5 text-mcl-blue ring-1 ring-mcl-blue/30'
                          : 'border-gray-200 text-gray-400 hover:border-gray-300'
                      }`}>
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              {/* Notify To */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Razon Social / Notify To</label>
                <textarea value={editing.notify_to}
                  onChange={e => setEditing({ ...editing, notify_to: e.target.value })}
                  rows={5} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none font-mono"
                  placeholder="Nombre, direccion, tax ID, telefono..." />
              </div>

              {/* Condicion de pago */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Condicion de Pago</label>
                <div className="flex gap-3 items-center">
                  <div className="flex gap-2">
                    {TERMS_DAYS_OPTIONS.map(d => (
                      <button key={d} type="button"
                        onClick={() => setEditing({ ...editing, payment_terms_days: d })}
                        className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-all ${
                          editing.payment_terms_days === d
                            ? 'border-mcl-blue bg-mcl-blue/5 text-mcl-blue ring-1 ring-mcl-blue/30'
                            : 'border-gray-200 text-gray-400 hover:border-gray-300'
                        }`}>
                        N{d}
                      </button>
                    ))}
                  </div>
                  <span className="text-xs text-gray-400">a partir de</span>
                  <select value={editing.payment_terms_from}
                    onChange={e => setEditing({ ...editing, payment_terms_from: e.target.value as 'service' | 'invoice' })}
                    className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm">
                    <option value="invoice">Fecha de facturación</option>
                    <option value="service">Fecha de servicio</option>
                  </select>
                </div>
              </div>

              {/* Contactos */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs font-medium text-gray-600">Contactos para Facturar</label>
                  <button type="button" onClick={addContact} className="text-xs text-mcl-blue hover:underline">+ Agregar</button>
                </div>
                <div className="space-y-2">
                  {editing.contacts.map((c, idx) => (
                    <div key={idx} className={`border rounded-lg p-3 relative transition-colors ${c.active === false ? 'border-red-200 bg-red-50/30 opacity-60' : 'border-gray-100'}`}>
                      <div className="absolute top-2 right-2 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const contacts = [...editing.contacts]
                            contacts[idx] = { ...contacts[idx], active: c.active === false ? true : false }
                            setEditing({ ...editing, contacts })
                          }}
                          className={`text-xs px-2 py-0.5 rounded font-medium transition-colors ${c.active === false ? 'bg-red-100 text-red-600 hover:bg-red-200' : 'bg-green-100 text-green-700 hover:bg-green-200'}`}
                          title={c.active === false ? 'Activar contacto' : 'Desactivar contacto'}
                        >
                          {c.active === false ? 'Inactivo' : 'Activo'}
                        </button>
                        {editing.contacts.length > 1 && (
                          <button onClick={() => removeContact(idx)}
                            className="text-red-400 hover:text-red-600 text-xs">x</button>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input value={c.name} onChange={e => updateContact(idx, 'name', e.target.value)}
                          placeholder="Nombre" className="border border-gray-200 rounded px-2 py-1.5 text-sm" />
                        <input value={c.role} onChange={e => updateContact(idx, 'role', e.target.value)}
                          placeholder="Rol" className="border border-gray-200 rounded px-2 py-1.5 text-sm" />
                        <input value={c.phone} onChange={e => updateContact(idx, 'phone', e.target.value)}
                          placeholder="Telefono" className="border border-gray-200 rounded px-2 py-1.5 text-sm" />
                        <input value={c.email} onChange={e => updateContact(idx, 'email', e.target.value)}
                          placeholder="Email" type="email" className="border border-gray-200 rounded px-2 py-1.5 text-sm" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Observaciones */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Observaciones</label>
                <textarea value={editing.observations}
                  onChange={e => setEditing({ ...editing, observations: e.target.value })}
                  rows={2} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none"
                  placeholder="Notas adicionales..." />
              </div>

              {/* Active toggle */}
              {editing.id && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={editing.active}
                    onChange={e => setEditing({ ...editing, active: e.target.checked })}
                    className="rounded border-gray-300 text-mcl-blue focus:ring-mcl-blue/30" />
                  <span className="text-sm text-gray-600">Perfil activo</span>
                </label>
              )}

              {/* Actions */}
              <div className="flex gap-3 pt-2">
                <button onClick={() => setEditing(null)}
                  className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm font-medium hover:bg-gray-50">
                  Cancelar
                </button>
                <button onClick={handleSave} disabled={saving}
                  className="flex-1 bg-mcl-blue text-white rounded-lg py-2.5 text-sm font-semibold hover:bg-blue-900 disabled:opacity-50">
                  {saving ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── CC Internos MCL ── */}
      {showCcEditor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4 max-h-[80vh] overflow-y-auto">
            <h3 className="font-semibold text-gray-800">CC Internos MCL</h3>
            <p className="text-xs text-gray-400">Estos correos van en CC en todos los emails de WR y Consolidado.</p>
            <div className="space-y-2">
              {ccRecipients.map((r, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input value={r.name} onChange={e => {
                    const arr = [...ccRecipients]; arr[idx] = { ...arr[idx], name: e.target.value }; setCcRecipients(arr)
                  }} placeholder="Nombre" className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-sm" />
                  <input value={r.email} onChange={e => {
                    const arr = [...ccRecipients]; arr[idx] = { ...arr[idx], email: e.target.value }; setCcRecipients(arr)
                  }} placeholder="Email" type="email" className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-sm" />
                  <button onClick={() => setCcRecipients(ccRecipients.filter((_, i) => i !== idx))}
                    className="text-red-400 hover:text-red-600 text-sm px-1">x</button>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setCcRecipients([...ccRecipients, { name: '', email: '' }])}
              className="text-xs text-mcl-blue hover:underline">+ Agregar CC</button>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setShowCcEditor(false)}
                className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm hover:bg-gray-50">
                Cancelar
              </button>
              <button onClick={saveCcRecipients} disabled={savingCc}
                className="flex-1 bg-mcl-blue text-white rounded-lg py-2.5 text-sm font-semibold hover:bg-blue-900 disabled:opacity-50">
                {savingCc ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirm ── */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <h3 className="font-semibold text-gray-800">Eliminar perfil</h3>
            <p className="text-sm text-gray-500">
              Eliminar el perfil de <span className="font-medium text-gray-700">{confirmDelete.customer_name}</span> ({confirmDelete.destinations.join(', ')})?
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDelete(null)} disabled={deleting}
                className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm hover:bg-gray-50">
                Cancelar
              </button>
              <button onClick={handleDelete} disabled={deleting}
                className="flex-1 bg-red-600 text-white rounded-lg py-2.5 text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
                {deleting ? 'Eliminando...' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
