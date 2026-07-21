import { useState, useEffect } from 'react'
import { collection, onSnapshot, query, orderBy, getDocs, where, deleteDoc, doc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { TruckingVendor, VendorUser } from '../../types'
import { saveVendor, deleteVendor, createVendorAdminAccount } from '../../lib/vendorAdmin'
import Layout from '../../components/Layout'

export default function AirfreightVendors() {
  const { isAdmin } = useAuth()
  const [vendors, setVendors] = useState<(TruckingVendor & { id: string })[]>([])
  const [users, setUsers] = useState<(VendorUser & { id: string })[]>([])
  const [editVendor, setEditVendor] = useState<TruckingVendor | null>(null)
  const [showVendorModal, setShowVendorModal] = useState(false)
  const [showUserModal, setShowUserModal] = useState(false)
  const [userForm, setUserForm] = useState({ email: '', password: '', name: '', vendor_id: '' })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const unsub1 = onSnapshot(query(collection(db, 'vendors'), orderBy('name')), snap => {
      setVendors(snap.docs.map(d => ({ ...d.data() as TruckingVendor, id: d.id })))
    })
    const unsub2 = onSnapshot(collection(db, 'vendor_users'), snap => {
      setUsers(snap.docs.map(d => ({ ...d.data() as VendorUser, id: d.id })))
    })
    return () => { unsub1(); unsub2() }
  }, [])

  async function handleSaveVendor() {
    if (!editVendor?.name.trim()) return
    setSaving(true)
    try {
      await saveVendor(editVendor)
      setShowVendorModal(false)
      setEditVendor(null)
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteVendor(id: string) {
    if (!confirm('Eliminar vendor?')) return
    await deleteVendor(id)
  }

  async function handleCreateUser() {
    if (!userForm.email || !userForm.password || !userForm.name || !userForm.vendor_id) return
    setSaving(true)
    try {
      await createVendorAdminAccount(userForm.email, userForm.password, userForm.name, userForm.vendor_id)
      setShowUserModal(false)
      setUserForm({ email: '', password: '', name: '', vendor_id: '' })
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteUser(uid: string) {
    if (!confirm('Eliminar usuario vendor?')) return
    try {
      const deleteUserFn = httpsCallable(functions, 'deleteVendorUser')
      await deleteUserFn({ uid })
    } catch (err: any) {
      alert(err.message)
    }
  }

  if (!isAdmin) return <Layout title="Vendors" backTo="/airfreight"><div className="text-center py-10 text-gray-400">Admin only</div></Layout>

  return (
    <Layout title="Trucking Vendors" backTo="/airfreight/admin">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Vendors */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-gray-500 uppercase">Vendors</span>
            <button onClick={() => { setEditVendor({ name: '', status: 'active', created_at: '' }); setShowVendorModal(true) }} className="text-xs font-semibold text-mcl-blue hover:underline">+ Nuevo</button>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase bg-gray-50">
                <th className="px-3 py-2 text-left">Nombre</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {vendors.map(v => (
                <tr key={v.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-semibold">{v.name}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${v.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{v.status}</span>
                  </td>
                  <td className="px-3 py-2 text-right space-x-2">
                    <button onClick={() => { setEditVendor(v); setShowVendorModal(true) }} className="text-mcl-blue hover:underline">Editar</button>
                    <button onClick={() => handleDeleteVendor(v.id)} className="text-red-400 hover:text-red-600">Eliminar</button>
                  </td>
                </tr>
              ))}
              {vendors.length === 0 && <tr><td colSpan={3} className="text-center py-6 text-gray-400">Sin vendors</td></tr>}
            </tbody>
          </table>
        </div>

        {/* Vendor Users */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-gray-500 uppercase">Usuarios Vendor</span>
            <button onClick={() => setShowUserModal(true)} disabled={vendors.length === 0} className="text-xs font-semibold text-mcl-blue hover:underline disabled:opacity-50">+ Nuevo</button>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase bg-gray-50">
                <th className="px-3 py-2 text-left">Nombre</th>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Vendor</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-semibold">{u.name}</td>
                  <td className="px-3 py-2">{u.email}</td>
                  <td className="px-3 py-2">{vendors.find(v => v.id === u.vendor_id)?.name || u.vendor_id}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => handleDeleteUser(u.uid)} className="text-red-400 hover:text-red-600">Eliminar</button>
                  </td>
                </tr>
              ))}
              {users.length === 0 && <tr><td colSpan={4} className="text-center py-6 text-gray-400">Sin usuarios</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* Vendor Modal */}
      {showVendorModal && editVendor && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-sm font-bold">{editVendor.id ? 'Editar' : 'Nuevo'} Vendor</h3>
            <input value={editVendor.name} onChange={e => setEditVendor({ ...editVendor, name: e.target.value })} placeholder="Nombre" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <select value={editVendor.status} onChange={e => setEditVendor({ ...editVendor, status: e.target.value as any })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowVendorModal(false); setEditVendor(null) }} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
              <button onClick={handleSaveVendor} disabled={saving} className="px-4 py-2 text-sm font-semibold bg-mcl-blue text-white rounded-lg disabled:opacity-50">{saving ? 'Guardando...' : 'Guardar'}</button>
            </div>
          </div>
        </div>
      )}

      {/* User Modal */}
      {showUserModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-sm font-bold">Nuevo Usuario Vendor</h3>
            <input value={userForm.name} onChange={e => setUserForm({ ...userForm, name: e.target.value })} placeholder="Nombre" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input value={userForm.email} onChange={e => setUserForm({ ...userForm, email: e.target.value })} placeholder="Email" type="email" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input value={userForm.password} onChange={e => setUserForm({ ...userForm, password: e.target.value })} placeholder="Password" type="password" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <select value={userForm.vendor_id} onChange={e => setUserForm({ ...userForm, vendor_id: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
              <option value="">Seleccionar vendor...</option>
              {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowUserModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
              <button onClick={handleCreateUser} disabled={saving || !userForm.email || !userForm.password || !userForm.name || !userForm.vendor_id} className="px-4 py-2 text-sm font-semibold bg-mcl-blue text-white rounded-lg disabled:opacity-50">{saving ? 'Creando...' : 'Crear'}</button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
