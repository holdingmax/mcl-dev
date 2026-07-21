import { doc, collection, addDoc, updateDoc, runTransaction } from 'firebase/firestore'
import { db } from './firebase'
import { AvDeliveryOrder } from '../types'

export async function getNextAvDoNumber(): Promise<string> {
  const seqRef = doc(db, 'config', 'av_do_sequence')
  const next = await runTransaction(db, async (tx) => {
    const snap = await tx.get(seqRef)
    const last = snap.exists() ? (snap.data().last_num || 0) : 0
    const n = last + 1
    tx.set(seqRef, { last_num: n }, { merge: true })
    return n
  })
  return `AV-${String(next).padStart(7, '0')}`
}

export async function saveAvDeliveryOrder(doData: AvDeliveryOrder): Promise<string> {
  if (doData.id) {
    const ref = doc(db, 'av_delivery_orders', doData.id)
    const { id: _id, ...rest } = doData
    await updateDoc(ref, { ...rest, updated_at: new Date().toISOString() } as any)
    return doData.id
  }
  const doNumber = await getNextAvDoNumber()
  const now = new Date().toISOString()
  const { id: _id, ...rest } = doData
  const ref = await addDoc(collection(db, 'av_delivery_orders'), {
    ...rest,
    do_number: doNumber,
    date: now,
    created_at: now,
  })
  return ref.id
}
