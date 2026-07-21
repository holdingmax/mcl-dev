import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from './firebase'
import { useAuth } from '../contexts/AuthContext'
import { useState, useEffect, useCallback } from 'react'

export const AV_FEATURES = [
  { key: 'view_flights', label: 'Ver vuelos y AWBs' },
  { key: 'create_flight', label: 'Crear vuelo' },
  { key: 'edit_flight', label: 'Editar/eliminar vuelo' },
  { key: 'add_awb', label: 'Agregar AWB' },
  { key: 'edit_awb', label: 'Editar AWB' },
  { key: 'delete_awb', label: 'Eliminar AWB' },
  { key: 'upload_doc', label: 'Subir doc AWB' },
  { key: 'upload_pt', label: 'Subir Pallet Tag' },
  { key: 'edit_pt', label: 'Editar/borrar Pallet Tag' },
  { key: 'manual_position', label: 'Crear posicion manual (BLK)' },
  { key: 'screening', label: 'Screening (certificar)' },
  { key: 'check_manifest', label: 'Check Manifest' },
  { key: 'create_do', label: 'Crear DO' },
  { key: 'edit_do', label: 'Editar/despachar DO' },
  { key: 'delete_do', label: 'Eliminar DO' },
  { key: 'tracking', label: 'Tracking (vista)' },
  { key: 'billing', label: 'Billing' },
  { key: 'config', label: 'Config' },
  { key: 'audit_log', label: 'Log (auditoria)' },
] as const

export type AvFeatureKey = (typeof AV_FEATURES)[number]['key']

export const AV_MCL_ROLES = [
  'admin', 'gerente', 'accounting', 'super_agent', 'agent', 'counter', 'dispatcher', 'distribuidor', 'soporte_it', 'av_viewer',
] as const

export const AV_ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  gerente: 'Gerente',
  accounting: 'Accounting',
  super_agent: 'Super Agent',
  agent: 'Agent',
  counter: 'Counter',
  dispatcher: 'Dispatcher',
  distribuidor: 'Distribuidor',
  soporte_it: 'Soporte IT',
  av_viewer: 'AV Viewer',
}

export type AvMatrix = Record<string, AvFeatureKey[]>

const ALL_FEATURES: AvFeatureKey[] = AV_FEATURES.map(f => f.key) as AvFeatureKey[]

export const DEFAULT_AV_MATRIX: AvMatrix = {
  admin: [...ALL_FEATURES],
  gerente: [...ALL_FEATURES],
  accounting: ['view_flights', 'tracking', 'billing', 'config', 'audit_log'],
  super_agent: ['view_flights', 'create_flight', 'edit_flight', 'add_awb', 'edit_awb', 'delete_awb', 'upload_doc', 'upload_pt', 'edit_pt', 'manual_position', 'screening', 'check_manifest', 'create_do', 'edit_do', 'delete_do', 'tracking', 'audit_log'],
  agent: ['view_flights', 'create_flight', 'add_awb', 'edit_awb', 'upload_doc', 'upload_pt', 'manual_position', 'create_do', 'edit_do', 'tracking'],
  counter: ['view_flights', 'create_flight', 'edit_flight', 'add_awb', 'edit_awb', 'delete_awb', 'upload_doc', 'upload_pt', 'edit_pt', 'manual_position', 'screening', 'check_manifest', 'create_do', 'edit_do', 'delete_do', 'tracking', 'audit_log'],
  dispatcher: ['view_flights', 'upload_pt', 'edit_pt', 'manual_position', 'screening', 'create_do', 'edit_do', 'delete_do', 'tracking'],
  distribuidor: ['view_flights', 'upload_pt', 'create_do', 'edit_do', 'tracking'],
  soporte_it: ['view_flights', 'tracking', 'audit_log'],
  av_viewer: ['view_flights', 'tracking'],
}

// Firestore
const PERMISSIONS_REF = doc(db, 'av_config', 'permissions')

export async function loadAvMatrix(): Promise<AvMatrix> {
  try {
    const snap = await getDoc(PERMISSIONS_REF)
    if (snap.exists()) {
      const data = snap.data()
      if (data.matrix) return data.matrix as AvMatrix
    }
  } catch { /* fall through to defaults */ }
  return { ...DEFAULT_AV_MATRIX }
}

export async function saveAvMatrix(matrix: AvMatrix): Promise<void> {
  await setDoc(PERMISSIONS_REF, {
    matrix,
    features: AV_FEATURES.map(f => ({ key: f.key, label: f.label })),
    updated_at: new Date().toISOString(),
  })
}

// Module-level cache
let _cachedMatrix: AvMatrix | null = null
let _loadPromise: Promise<AvMatrix> | null = null

function getMatrixPromise(): Promise<AvMatrix> {
  if (_cachedMatrix) return Promise.resolve(_cachedMatrix)
  if (!_loadPromise) {
    _loadPromise = loadAvMatrix().then(m => {
      _cachedMatrix = m
      _loadPromise = null
      return m
    })
  }
  return _loadPromise
}

export function invalidateAvMatrixCache() {
  _cachedMatrix = null
  _loadPromise = null
}

export function useAvCan() {
  const { userRole, avRole } = useAuth()
  const [matrix, setMatrix] = useState<AvMatrix>(_cachedMatrix || DEFAULT_AV_MATRIX)

  useEffect(() => {
    getMatrixPromise().then(m => setMatrix(m))
  }, [])

  // Use av_role if set, otherwise fall back to global role
  const effectiveRole = avRole || userRole

  const canAv = useCallback((key: AvFeatureKey): boolean => {
    if (!effectiveRole) return false
    const perms = matrix[effectiveRole]
    if (!perms) return false
    return perms.includes(key)
  }, [effectiveRole, matrix])

  return { canAv, matrix }
}
