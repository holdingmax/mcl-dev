import {
  collection, addDoc, updateDoc, deleteDoc, doc, setDoc,
} from 'firebase/firestore'
import { db, createUserWithoutSignIn } from './firebase'
import { TruckingVendor, UserRole } from '../types'

export async function saveVendor(vendor: TruckingVendor): Promise<string> {
  if (vendor.id) {
    const { id, ...rest } = vendor
    await updateDoc(doc(db, 'vendors', id), rest)
    return id
  }
  const docRef = await addDoc(collection(db, 'vendors'), {
    name: vendor.name,
    status: vendor.status,
    created_at: new Date().toISOString(),
  })
  return docRef.id
}

export async function deleteVendor(id: string) {
  await deleteDoc(doc(db, 'vendors', id))
}

export async function createVendorAdminAccount(
  email: string,
  password: string,
  name: string,
  vendorId: string,
) {
  const uid = await createUserWithoutSignIn(email, password)

  // Create vendor_users doc
  await setDoc(doc(db, 'vendor_users', uid), {
    uid,
    email,
    name,
    vendor_id: vendorId,
    role: 'vendor_admin' as UserRole,
    created_at: new Date().toISOString(),
  })

  // Create user_roles doc
  await setDoc(doc(db, 'user_roles', uid), {
    role: 'vendor_admin' as UserRole,
    module_access: ['airfreight'],
    client_id: null,
    name,
    email,
    must_change_password: true,
    created_at: new Date().toISOString(),
  })

  return uid
}
