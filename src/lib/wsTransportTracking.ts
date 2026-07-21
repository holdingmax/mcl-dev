/**
 * WS Transport Tracking — driver milestones for Transport-Only SOs
 * Uses ws_delivery_tracking collection (separate from airfreight delivery_tracking)
 */
import {
  collection, addDoc, updateDoc, doc, runTransaction,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from './firebase'
import { generateDriverPin } from './driverTracking'
import type { WSDeliveryTracking, WSDeliveryOrder, WSTransportType } from '../types'

// ── Generate WS-DO number: WS-DO-NNNNN ──
export async function generateWsDoNumber(): Promise<string> {
  const seqRef = doc(db, 'config', 'ws_do_sequence')
  const num = await runTransaction(db, async (tx) => {
    const snap = await tx.get(seqRef)
    const current = snap.exists() ? (snap.data().current || 0) : 0
    const next = current + 1
    tx.set(seqRef, { current: next })
    return next
  })
  return `WS-DO-${String(num).padStart(5, '0')}`
}

// ── Create WS Delivery Order + Tracking ──
export async function createWSDeliveryOrder(data: {
  so_id: string
  so_number: string
  client_id: string
  client_name: string
  pickup_from: string
  deliver_to: string
  extra_stops: string[]
  transport_type: WSTransportType
  bup_count: number | null
  uld_numbers: string[]
  total_pieces: number
  total_weight: number
  trucking_company: string
  driver_name: string
  driver_id: string | null
  custody_method: string | null
  seal_number: string | null
  mcl_agent: string
  created_by: string
}): Promise<{ doId: string; doNumber: string; pin: string; trackingId: string }> {
  const doNumber = await generateWsDoNumber()
  const pin = generateDriverPin()
  const now = new Date().toISOString()

  // Create DO
  const doDoc: Omit<WSDeliveryOrder, 'id'> = {
    do_number: doNumber,
    so_id: data.so_id,
    so_number: data.so_number,
    client_id: data.client_id,
    client_name: data.client_name,
    pickup_from: data.pickup_from,
    deliver_to: data.deliver_to,
    extra_stops: data.extra_stops,
    transport_type: data.transport_type,
    bup_count: data.bup_count,
    uld_numbers: data.uld_numbers,
    total_pieces: data.total_pieces,
    total_weight: data.total_weight,
    trucking_company: data.trucking_company,
    driver_name: data.driver_name,
    driver_id: data.driver_id,
    custody_method: data.custody_method,
    seal_number: data.seal_number,
    mcl_agent: data.mcl_agent,
    driver_pin: pin,
    tracking_id: null,
    status: 'active',
    delivered_at: null,
    created_at: now,
    created_by: data.created_by,
  }

  const doRef = await addDoc(collection(db, 'ws_delivery_orders'), doDoc)

  // Create tracking doc
  const tracking: Omit<WSDeliveryTracking, 'id'> = {
    do_id: doRef.id,
    do_number: doNumber,
    so_id: data.so_id,
    so_number: data.so_number,
    driver_pin: pin,
    driver_name: data.driver_name,
    vendor_id: null,
    vendor_name: data.trucking_company,
    driver_plate: null,
    driver_queue_id: null,
    pickup_from: data.pickup_from,
    deliver_to: data.deliver_to,
    extra_stops: data.extra_stops,
    transport_type: data.transport_type,
    bup_count: data.bup_count,
    uld_numbers: data.uld_numbers,
    total_pieces: data.total_pieces,
    total_weight: data.total_weight,
    client_id: data.client_id,
    client_name: data.client_name,
    milestones: {},
    receiver_name: null,
    receiver_id: null,
    delivery_notes: null,
    delivery_photo_urls: [],
    status: 'pending',
    created_at: now,
  }

  const trackRef = await addDoc(collection(db, 'ws_delivery_tracking'), tracking)

  // Link tracking to DO
  await updateDoc(doRef, { tracking_id: trackRef.id })

  return { doId: doRef.id, doNumber, pin, trackingId: trackRef.id }
}

// ── Build milestone keys for a WS transport DO ──
export function buildMilestoneKeys(extraStops: string[]): { key: string; label: string; address?: string }[] {
  const keys: { key: string; label: string; address?: string }[] = [
    { key: 'accepted', label: 'Order Accepted' },
    { key: 'at_pickup', label: 'Arrived at Pickup' },
    { key: 'loaded', label: 'Cargo Loaded' },
  ]
  extraStops.forEach((addr, i) => {
    keys.push({ key: `stop_${i}`, label: `Stop ${i + 1}`, address: addr })
  })
  keys.push({ key: 'delivered', label: 'Delivered' })
  return keys
}

// ── Record WS milestone ──
export async function recordWSMilestone(
  trackingId: string,
  milestone: string,
  gps: { lat: number; lng: number },
  photoUrls?: string[],
) {
  const milestoneData: Record<string, any> = {
    timestamp: new Date().toISOString(),
    gps,
  }
  if (photoUrls && photoUrls.length > 0) {
    milestoneData.photo_urls = photoUrls
  }

  const updates: Record<string, any> = {
    [`milestones.${milestone}`]: milestoneData,
  }

  if (milestone === 'accepted') {
    updates.status = 'in_progress'
  }

  await updateDoc(doc(db, 'ws_delivery_tracking', trackingId), updates)
}

// ── Complete delivery (final milestone) ──
export async function completeWSDelivery(
  trackingId: string,
  gps: { lat: number; lng: number },
  receiverName: string | null,
  receiverId: string | null,
  notes: string | null,
  photoUrls: string[],
) {
  const now = new Date().toISOString()

  // Record delivered milestone
  await updateDoc(doc(db, 'ws_delivery_tracking', trackingId), {
    'milestones.delivered': {
      timestamp: now,
      gps,
      photo_urls: photoUrls,
    },
    receiver_name: receiverName,
    receiver_id: receiverId,
    delivery_notes: notes,
    delivery_photo_urls: photoUrls,
    status: 'completed',
  })

}

// ── Upload driver photo ──
export async function uploadWSDriverPhoto(file: File): Promise<string> {
  const path = `ws-transport/driver-photos/${Date.now()}_${file.name}`
  const storageRef = ref(storage, path)
  await uploadBytes(storageRef, file)
  return getDownloadURL(storageRef)
}
