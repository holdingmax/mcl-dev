import {
  collection, addDoc, updateDoc, doc, getDoc, arrayUnion,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from './firebase'
import { DriverQueueEntry, DeliveryTracking, TrackingCorrection } from '../types'

const MILESTONE_ORDER = [
  'arrival_mcl', 'truck_loaded', 'arrival_airline',
  'gate_assigned', 'unload_start', 'unload_end',
] as const

export function generateDriverPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000))
}

export async function createDriverQueueEntry(data: {
  driver_name: string
  vendor_id: string | null
  vendor_name: string
  plate: string | null
  gps: { lat: number; lng: number }
}): Promise<string> {
  const now = new Date()
  const expires = new Date(now.getTime() + 3 * 60 * 60 * 1000) // +3h
  const entry: Omit<DriverQueueEntry, 'id'> = {
    ...data,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    linked_do_id: null,
    status: 'waiting',
  }
  const docRef = await addDoc(collection(db, 'driver_queue'), entry)
  return docRef.id
}

export async function linkDriverToDeliveryOrder(queueId: string, doId: string) {
  await updateDoc(doc(db, 'driver_queue', queueId), {
    status: 'linked',
    linked_do_id: doId,
  })
}

export async function createDeliveryTracking(data: {
  do_id: string
  do_number: string
  driver_pin: string
  driver_name: string
  vendor_id: string | null
  vendor_name: string
  driver_plate: string | null
  driver_queue_id: string | null
  airline: string
}): Promise<string> {
  const tracking: Omit<DeliveryTracking, 'id'> = {
    ...data,
    milestones: {},
    corrections: [],
    status: 'pending',
    created_at: new Date().toISOString(),
  }
  const docRef = await addDoc(collection(db, 'delivery_tracking'), tracking)
  return docRef.id
}

export async function recordMilestone(
  trackingId: string,
  milestone: typeof MILESTONE_ORDER[number],
  gps: { lat: number; lng: number },
  sealPhotoUrl?: string,
) {
  const milestoneData: Record<string, any> = {
    timestamp: new Date().toISOString(),
    gps,
  }
  if (milestone === 'truck_loaded' && sealPhotoUrl) {
    milestoneData.seal_photo_url = sealPhotoUrl
  }

  const updates: Record<string, any> = {
    [`milestones.${milestone}`]: milestoneData,
  }

  // Update status
  if (milestone === 'arrival_mcl') {
    updates.status = 'in_progress'
  } else if (milestone === 'unload_end') {
    updates.status = 'completed'
  }

  await updateDoc(doc(db, 'delivery_tracking', trackingId), updates)
}

export async function uploadSealPhoto(file: File): Promise<string> {
  const path = `airfreight/tracking-photos/${Date.now()}_${file.name}`
  const storageRef = ref(storage, path)
  await uploadBytes(storageRef, file)
  return getDownloadURL(storageRef)
}

export function captureGps(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('GPS no disponible'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(`Error GPS: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 15000 },
    )
  })
}

export async function saveDriverNotes(
  trackingId: string,
  comment: string,
  photoFiles: File[],
  existingPhotoUrls: string[],
) {
  // Upload new photos
  const newUrls: string[] = []
  for (const file of photoFiles) {
    const url = await uploadSealPhoto(file)
    newUrls.push(url)
  }
  const allUrls = [...existingPhotoUrls, ...newUrls]
  await updateDoc(doc(db, 'delivery_tracking', trackingId), {
    driver_notes: {
      comment,
      photo_urls: allUrls,
      updated_at: new Date().toISOString(),
    },
  })
}

export async function requestCorrection(
  trackingId: string,
  correction: Omit<TrackingCorrection, 'approved_by' | 'approved_at' | 'status'>,
) {
  const full: TrackingCorrection = {
    ...correction,
    approved_by: null,
    approved_at: null,
    status: 'pending',
  }
  await updateDoc(doc(db, 'delivery_tracking', trackingId), {
    corrections: arrayUnion(full),
  })
}

export async function approveCorrection(
  trackingId: string,
  correctionIndex: number,
  approvedBy: string,
  approve: boolean,
) {
  const snap = await getDoc(doc(db, 'delivery_tracking', trackingId))
  if (!snap.exists()) throw new Error('Tracking not found')
  const data = snap.data() as DeliveryTracking
  const corrections = [...data.corrections]
  const correction = corrections[correctionIndex]
  if (!correction) throw new Error('Correction not found')

  correction.status = approve ? 'approved' : 'rejected'
  correction.approved_by = approvedBy
  correction.approved_at = new Date().toISOString()

  const updates: Record<string, any> = { corrections }

  // If approved, also update the milestone timestamp
  if (approve) {
    updates[`milestones.${correction.milestone}.timestamp`] = correction.new_timestamp
  }

  await updateDoc(doc(db, 'delivery_tracking', trackingId), updates)
}
