import { useState, useEffect } from 'react'
import { collection, query, orderBy, onSnapshot, addDoc, updateDoc, doc } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import type { WSClient } from '../../types'

const emptyClient: Omit<WSClient, 'id' | 'created_at'> = {
  name: '',
  company_legal_name: '',
  contact_name: '',
  contact_email: '',
  contact_phone: '',
  address: '',
  tax_id: null,
  type: 'spot',
  email_recipients: [],
  billing_address: '',
  payment_terms_days: 30,
  payment_terms_label: 'N30',
  active: true,
  notes: '',
}

export default function WSClients() {
  const { isAdmin, isSuperAgent, isAccounting } = useAuth()
  const [clients, setClients] = useState<WSClient[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(false)

  // Modal
  const [editing, setEditing] = useState<WSClient | null>(null)
  const [form, setForm] = useState(emptyClient)
  const [saving, setSaving] = useState(false)

  // Email recipient temp fields
  const [newRecipientName, setNewRecipientName] = useState('')
  const [newRecipientEmail, setNewRecipientEmail] = useState('')

  useEffect(() => {
    const q = query(collection(db, 'warehouse_service_clients'), orderBy('name'))
    const unsub = onSnapshot(q, snap => {
      setClients(snap.docs.map(d => ({ id: d.id, ...d.data() } as WSClient)))
      setLoading(false)
    })
    return unsub
  }, [])

  function openNew() {
    setForm({ ...emptyClient })
    setEditing({} as WSClient) // truthy but no id = new
  }

  function openEdit(c: WSClient) {
    setForm({
      name: c.name,
      company_legal_name: c.company_legal_name,
      contact_name: c.contact_name,
      contact_email: c.contact_email,
      contact_phone: c.contact_phone,
      address: c.address,
      tax_id: c.tax_id,
      type: c.type,
      email_recipients: [...c.email_recipients],
      billing_address: c.billing_address,
      payment_terms_days: c.payment_terms_days,
      payment_terms_label: c.payment_terms_label,
      active: c.active,
      notes: c.notes,
    })
    setEditing(c)
  }

  function closeModal() {
    setEditing(null)
    setNewRecipientName('')
    setNewRecipientEmail('')
  }

  function addRecipient() {
    if (!newRecipientName.trim() || !newRecipientEmail.trim()) return
    setForm(prev => ({
      ...prev,
      email_recipients: [...prev.email_recipients, { name: newRecipientName.trim(), email: newRecipientEmail.trim() }],
    }))
    setNewRecipientName('')
    setNewRecipientEmail('')
  }

  function removeRecipient(idx: number) {
    setForm(prev => ({ ...prev, email_recipients: prev.email_recipients.filter((_, i) => i !== idx) }))
  }

  async function handleSave() {
    if (!form.name.trim()) { alert('Name is required.'); return }
    setSaving(true)
    try {
      const data = { ...form, name: form.name.trim() }
      if (editing?.id) {
        await updateDoc(doc(db, 'warehouse_service_clients', editing.id), data)
      } else {
        await addDoc(collection(db, 'warehouse_service_clients'), { ...data, created_at: new Date().toISOString() })
      }
      closeModal()
    } catch (e) {
      alert('Error: ' + (e instanceof Error ? e.message : String(e)))
    }
    setSaving(false)
  }

  async function toggleActive(c: WSClient) {
    await updateDoc(doc(db, 'warehouse_service_clients', c.id!), { active: !c.active })
  }

  const filtered = clients.filter(c => {
    if (!showInactive && !c.active) return false
    if (search) {
      const s = search.toLowerCase()
      return c.name.toLowerCase().includes(s) || c.contact_email.toLowerCase().includes(s)
    }
    return true
  })

  const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30'
  const labelClass = 'text-xs font-semibold text-gray-500 uppercase block mb-1'

  if (!isAdmin && !isSuperAgent && !isAccounting) {
    return (
      <Layout title="Clients" backTo="/warehouse-services/admin">
        <p className="text-center text-gray-500 mt-10">Access restricted to Admin / Super Agent / Accounting</p>
      </Layout>
    )
  }

  return (
    <Layout title="WS Clients" backTo="/warehouse-services">
      <div className="max-w-4xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-800">Clients</h1>
          <button onClick={openNew} className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors">
            + New Client
          </button>
        </div>

        {/* Filters */}
        <div className="flex gap-3 mb-4">
          <input type="text" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} className={inputClass + ' max-w-xs'} />
          <label className="flex items-center gap-1.5 text-sm text-gray-500 cursor-pointer">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} className="accent-mcl-blue" />
            Inactive
          </label>
        </div>

        {/* Inline Form */}
        {editing && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 mb-6">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-bold text-mcl-blue uppercase tracking-wide">{editing.id ? 'Edit Client' : 'New Client'}</h2>
              <button onClick={closeModal} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className={labelClass}>Name *</label>
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Legal Name</label>
                <input value={form.company_legal_name} onChange={e => setForm(p => ({ ...p, company_legal_name: e.target.value }))} className={inputClass} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Type</label>
                  <select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value as 'spot' | 'recurring' }))} className={inputClass}>
                    <option value="spot">Spot</option>
                    <option value="recurring">Recurring</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Tax ID</label>
                  <input value={form.tax_id || ''} onChange={e => setForm(p => ({ ...p, tax_id: e.target.value || null }))} className={inputClass} />
                </div>
              </div>

              <div className="border-t border-gray-100 pt-4">
                <div className="text-xs font-bold text-gray-500 uppercase mb-2">Primary Contact</div>
                <div className="space-y-2">
                  <input placeholder="Name" value={form.contact_name} onChange={e => setForm(p => ({ ...p, contact_name: e.target.value }))} className={inputClass} />
                  <div className="grid grid-cols-2 gap-2">
                    <input placeholder="Email" value={form.contact_email} onChange={e => setForm(p => ({ ...p, contact_email: e.target.value }))} className={inputClass} />
                    <input placeholder="Phone" value={form.contact_phone} onChange={e => setForm(p => ({ ...p, contact_phone: e.target.value }))} className={inputClass} />
                  </div>
                </div>
              </div>

              <div className="border-t border-gray-100 pt-4">
                <div className="text-xs font-bold text-gray-500 uppercase mb-2">Address</div>
                <input placeholder="Address" value={form.address} onChange={e => setForm(p => ({ ...p, address: e.target.value }))} className={inputClass} />
              </div>

              <div className="border-t border-gray-100 pt-4">
                <div className="text-xs font-bold text-gray-500 uppercase mb-2">Billing</div>
                <input placeholder="Billing address" value={form.billing_address} onChange={e => setForm(p => ({ ...p, billing_address: e.target.value }))} className={inputClass + ' mb-2'} />
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelClass}>Payment days</label>
                    <input type="number" value={form.payment_terms_days} onChange={e => setForm(p => ({ ...p, payment_terms_days: parseInt(e.target.value) || 30 }))} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Label</label>
                    <input value={form.payment_terms_label} onChange={e => setForm(p => ({ ...p, payment_terms_label: e.target.value }))} className={inputClass} />
                  </div>
                </div>
              </div>

              <div className="border-t border-gray-100 pt-4">
                <div className="text-xs font-bold text-gray-500 uppercase mb-2">Email Recipients</div>
                {form.email_recipients.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 mb-1.5 text-sm">
                    <span className="flex-1">{r.name}</span>
                    <span className="flex-1 text-gray-400">{r.email}</span>
                    <button onClick={() => removeRecipient(i)} className="text-red-400 hover:text-red-600 text-xs">x</button>
                  </div>
                ))}
                <div className="flex gap-2 mt-2">
                  <input placeholder="Name" value={newRecipientName} onChange={e => setNewRecipientName(e.target.value)} className={inputClass + ' flex-1'} />
                  <input placeholder="Email" value={newRecipientEmail} onChange={e => setNewRecipientEmail(e.target.value)} className={inputClass + ' flex-1'} />
                  <button onClick={addRecipient} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-2 rounded-lg">+</button>
                </div>
              </div>

              <div className="border-t border-gray-100 pt-4">
                <label className={labelClass}>Notes</label>
                <textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={3} className={inputClass} />
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={closeModal} className="text-sm text-gray-500 hover:text-gray-700 border border-gray-300 px-4 py-2 rounded-lg" disabled={saving}>Cancel</button>
              <button onClick={handleSave} disabled={saving} className="text-sm bg-mcl-blue hover:bg-blue-900 text-white font-semibold px-5 py-2 rounded-lg disabled:opacity-50">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {/* List */}
        {!editing && (loading ? (
          <div className="text-center py-20 text-gray-400">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-gray-400">No clients</div>
        ) : (
          <div className="space-y-3">
            {filtered.map(c => (
              <div key={c.id} className={`bg-white rounded-xl shadow-sm border p-4 ${!c.active ? 'opacity-50' : ''}`}>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-gray-800">{c.name}</span>
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${c.type === 'recurring' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                        {c.type === 'recurring' ? 'Recurring' : 'Spot'}
                      </span>
                    </div>
                    <div className="text-xs text-gray-400 mt-1">
                      {c.contact_name && <span>{c.contact_name}</span>}
                      {c.contact_email && <span> &middot; {c.contact_email}</span>}
                      {c.contact_phone && <span> &middot; {c.contact_phone}</span>}
                    </div>
                    {c.email_recipients.length > 0 && (
                      <div className="text-xs text-gray-400 mt-1">
                        {c.email_recipients.length} email recipient{c.email_recipients.length !== 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 text-xs">
                    <button onClick={() => openEdit(c)} className="text-mcl-blue hover:underline">Edit</button>
                    <button onClick={() => toggleActive(c)} className={`hover:underline ${c.active ? 'text-red-500' : 'text-green-600'}`}>
                      {c.active ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Layout>
  )
}
