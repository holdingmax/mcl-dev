import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import { db, storage } from '../lib/firebase'
import {
  collection, getDocs, query, where, doc, setDoc, updateDoc, addDoc, limit, writeBatch,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL, deleteObject, getBytes } from 'firebase/storage'
import { WarehouseReceipt, WRLine, InventoryDocument, DocCheckState, InvDocFile, InvDocComment, getDocSemaphore, Client, Dispatch } from '../types'
import { formatWRDate, toTitleCase, fmtNum } from '../lib/utils'
import { useAuth } from '../contexts/AuthContext'
import { mergePdfBuffers } from '../lib/deliveryOrder'
import { MCL_CC_RECIPIENTS } from '../data/emailRecipients'

const DOC_TYPES = ['sli', 'pl', 'inv', 'co', 'mc', '7512', 'dreb'] as const
const DOC_LABELS: Record<string, string> = { sli: 'SLI', pl: 'PL', inv: 'INV', co: 'CO', mc: 'MC', '7512': '7512', dreb: 'DREB' }

/* ─── helpers ─────────────────────────────────────────────────────────────── */

function semaphoreClasses(color: string) {
  if (color === 'blue')   return 'bg-blue-500'
  if (color === 'yellow') return 'bg-yellow-400'
  return 'bg-gray-300'
}

function checkDisplay(val: DocCheckState) {
  if (val === 'check') return { text: '\u2713', cls: 'bg-green-100 text-green-700 font-bold' }
  if (val === 'na')    return { text: 'NA', cls: 'bg-gray-200 text-gray-500 font-semibold' }
  return { text: '', cls: 'bg-gray-50 text-gray-300' }
}

function cycleCheck(val: DocCheckState): DocCheckState {
  if (val === null)    return 'check'
  if (val === 'check') return 'na'
  return null
}

interface RowData {
  wr: WarehouseReceipt & { lines: WRLine[] }
  invDoc: InventoryDocument
  dispatch?: Dispatch
}

/* ─── main component ──────────────────────────────────────────────────────── */

export default function InventoryDocuments() {
  const navigate = useNavigate()
  const { user, isClient, clientId: authClientId, gmailToken, refreshGmailToken } = useAuth()
  const [rows, setRows] = useState<RowData[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterClient, setFilterClient] = useState('')
  const [filterCountry, setFilterCountry] = useState('')
  const [filterStatus, setFilterStatus] = useState<'' | 'warehouse' | 'reserved' | 'gateout'>('')
  const [filterBooking, setFilterBooking] = useState('')
  const [filterBookingLI, setFilterBookingLI] = useState('')

  // Modal state
  const [uploadRow, setUploadRow] = useState<RowData | null>(null)
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [uploadChecks, setUploadChecks] = useState<Set<string>>(new Set())
  const [uploading, setUploading] = useState(false)

  const [filesRow, setFilesRow] = useState<RowData | null>(null)
  const [commentsRow, setCommentsRow] = useState<RowData | null>(null)
  const [commentText, setCommentText] = useState('')

  // Inline editable fields
  const [editingField, setEditingField] = useState<{ wrId: string; field: 'schedule' | 'br' } | null>(null)
  const [editingValue, setEditingValue] = useState('')

  const uid = user?.email || user?.uid || 'unknown'
  const [downloadingSet, setDownloadingSet] = useState<string | null>(null)
  const [sendingEmail, setSendingEmail] = useState<string | null>(null)

  useEffect(() => { loadData() }, [])

  async function loadData() {
    setLoading(true)
    try {
      // Load WRs with physical_status = complete (same as Inventory)
      const constraints: any[] = [where('physical_status', '==', 'complete')]
      if (isClient && authClientId) constraints.push(where('client_id', '==', authClientId))
      const wrSnap = await getDocs(query(collection(db, 'warehouse_receipts'), ...constraints, limit(1000)))
      const wrs = (wrSnap.docs.map(d => ({ id: d.id, ...d.data() })) as WarehouseReceipt[])
        .filter(wr => wr.source !== 'warehouse_services')
      console.log(`[InvDocs] Loaded ${wrs.length} WRs`)
      const targetWR = wrs.find(w => w.po_number?.includes('15340248'))
      if (targetWR) console.log('[InvDocs] Found PO 15340248, WR id:', targetWR.id, 'data:', JSON.stringify({ wr_number: targetWR.wr_number, po_number: targetWR.po_number, physical_status: targetWR.physical_status, dispatch_status: targetWR.dispatch_status, client_name: targetWR.client_name, client_id: targetWR.client_id }))

      // Load lines for each WR
      const wrsWithLines = await Promise.all(wrs.map(async wr => {
        const linesSnap = await getDocs(collection(db, 'warehouse_receipts', wr.id!, 'lines'))
        const lines = linesSnap.docs
          .map(d => ({ id: d.id, ...d.data() }) as WRLine)
          .sort((a, b) => (a.line_order ?? 0) - (b.line_order ?? 0))
        return { ...wr, lines }
      }))

      // Load existing inventory_documents
      const idConstraints: any[] = []
      if (isClient && authClientId) idConstraints.push(where('client_id', '==', authClientId))
      const idSnap = await getDocs(query(collection(db, 'inventory_documents'), ...idConstraints))
      const existingDocs = new Map<string, InventoryDocument>()
      for (const d of idSnap.docs) {
        const data = { id: d.id, ...d.data() } as InventoryDocument
        existingDocs.set(data.wr_id, data)
      }
      if (targetWR) console.log('[InvDocs] Has existing invDoc?', existingDocs.has(targetWR.id!), 'invDoc wr_id keys sample:', [...existingDocs.keys()].slice(0, 5))

      // Load dispatches and build wrId -> dispatch map
      const dispatchConstraints: any[] = []
      if (isClient && authClientId) dispatchConstraints.push(where('client_ids', 'array-contains', authClientId))
      const dispatchSnap = await getDocs(dispatchConstraints.length ? query(collection(db, 'dispatches'), ...dispatchConstraints) : collection(db, 'dispatches'))
      const wrIdToDispatch = new Map<string, Dispatch>()
      for (const d of dispatchSnap.docs) {
        const disp = { id: d.id, ...d.data() } as Dispatch
        for (const wrId of (disp.wr_ids || [])) {
          wrIdToDispatch.set(wrId, disp)
        }
      }

      // Build rows, create missing inventory_documents lazily (SOL-11: batched writes)
      const result: RowData[] = []
      const batchOps: Array<{ type: 'update' | 'set'; ref: any; data: any }> = []
      for (const wr of wrsWithLines) {
        try {
          let invDoc = existingDocs.get(wr.id!)
          if (invDoc) {
            const totalPcs = wr.lines?.reduce((s, l) => s + (l.qty || 0), 0) || 0
            const totalCbm = wr.lines?.reduce((s, l) => s + (l.cbm || 0), 0) || 0
            const totalKg  = wr.lines?.reduce((s, l) => s + (l.weight_kg || 0), 0) || 0
            const updates: Record<string, any> = {}
            if ((wr.po_number || '') !== invDoc.po_number) updates.po_number = wr.po_number || ''
            if ((wr.wr_number || '') !== invDoc.wr_number) updates.wr_number = wr.wr_number || ''
            if ((wr.company_name || '') !== invDoc.vendor) updates.vendor = wr.company_name || ''
            if ((wr.to_port || '') !== invDoc.country) updates.country = wr.to_port || ''
            if ((wr.cargo_type || '') !== invDoc.cargo_type) updates.cargo_type = wr.cargo_type || ''
            if ((wr.client_name || '') !== invDoc.client_name) updates.client_name = wr.client_name || ''
            if (totalPcs !== invDoc.total_pieces) updates.total_pieces = totalPcs
            if (totalCbm !== invDoc.total_cbm) updates.total_cbm = totalCbm
            if (totalKg !== invDoc.total_kg) updates.total_kg = totalKg
            if (Object.keys(updates).length > 0) {
              batchOps.push({ type: 'update', ref: doc(db, 'inventory_documents', invDoc.id!), data: updates })
              invDoc = { ...invDoc, ...updates }
            }
          }
          if (!invDoc) {
            const totalPcs = wr.lines?.reduce((s, l) => s + (l.qty || 0), 0) || 0
            const totalCbm = wr.lines?.reduce((s, l) => s + (l.cbm || 0), 0) || 0
            const totalKg  = wr.lines?.reduce((s, l) => s + (l.weight_kg || 0), 0) || 0
            const newRef = doc(collection(db, 'inventory_documents'))
            const newDoc: InventoryDocument = {
              wr_id: wr.id!,
              wr_number: wr.wr_number || '',
              po_number: wr.po_number || '',
              vendor: wr.company_name || '',
              country: wr.to_port || '',
              cargo_type: wr.cargo_type || '',
              total_pieces: totalPcs,
              total_cbm: totalCbm,
              total_kg: totalKg,
              client_id: wr.client_id || null,
              client_name: wr.client_name || '',
              schedule: '',
              schedule_locked: false,
              br: '',
              br_locked: false,
              check_sli: null,
              check_pl: null,
              check_inv: null,
              check_co: null,
              check_mc: null,
              check_7512: null,
              check_dreb: null,
              files: [],
              comments: [],
              last_modified_by: uid,
              last_modified_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            }
            newDoc.id = newRef.id
            batchOps.push({ type: 'set', ref: newRef, data: newDoc })
            invDoc = newDoc
          }
          result.push({ wr, invDoc, dispatch: wrIdToDispatch.get(wr.id!) })
        } catch (wrErr) {
          console.error(`Error processing WR ${wr.id} (${wr.wr_number}):`, wrErr)
        }
      }
      // Commit all writes in batches of 500
      for (let i = 0; i < batchOps.length; i += 500) {
        const batch = writeBatch(db)
        for (const op of batchOps.slice(i, i + 500)) {
          if (op.type === 'update') batch.update(op.ref, op.data)
          else batch.set(op.ref, op.data)
        }
        await batch.commit()
      }
      console.log(`[InvDocs] Built ${result.length} rows. Has 15340248?`, result.some(r => r.wr.po_number?.includes('15340248')))
      result.sort((a, b) => (b.wr.created_at ?? '').localeCompare(a.wr.created_at ?? ''))
      setRows(result)
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  // Update local state after Firestore save
  function updateLocalDoc(wrId: string, patch: Partial<InventoryDocument>) {
    setRows(prev => prev.map(r =>
      r.wr.id === wrId ? { ...r, invDoc: { ...r.invDoc, ...patch } } : r
    ))
    // Also update modal rows if open
    if (filesRow?.wr.id === wrId) setFilesRow(prev => prev ? { ...prev, invDoc: { ...prev.invDoc, ...patch } } : prev)
    if (commentsRow?.wr.id === wrId) setCommentsRow(prev => prev ? { ...prev, invDoc: { ...prev.invDoc, ...patch } } : prev)
    if (uploadRow?.wr.id === wrId) setUploadRow(prev => prev ? { ...prev, invDoc: { ...prev.invDoc, ...patch } } : prev)
  }

  async function saveField(invDoc: InventoryDocument, field: string, value: any) {
    const patch: any = {
      [field]: value,
      last_modified_by: uid,
      last_modified_at: new Date().toISOString(),
    }
    await updateDoc(doc(db, 'inventory_documents', invDoc.id!), patch)
    updateLocalDoc(invDoc.wr_id, patch)
  }

  /* ─── Gate out lock check ───────────────────────────────────────────────── */
  function isLocked(row: RowData) {
    return row.wr.dispatch_status === 'dispatched'
  }

  function canOverrideLock() {
    return !isClient
  }

  function confirmUnlock(): boolean {
    return window.confirm('ALERTA: Este WR ya tiene Gate Out. Los cambios quedan registrados. ¿Desea continuar?')
  }

  function guardEdit(row: RowData): boolean {
    if (!isLocked(row)) return true
    if (!canOverrideLock()) { alert('Bloqueado - Gate Out realizado.'); return false }
    return confirmUnlock()
  }

  /* ─── Check toggle ──────────────────────────────────────────────────────── */
  async function toggleCheck(row: RowData, key: 'check_sli' | 'check_pl' | 'check_inv' | 'check_co' | 'check_mc' | 'check_7512' | 'check_dreb') {
    const next = cycleCheck(row.invDoc[key])
    await saveField(row.invDoc, key, next)
  }

  /* ─── Lockable text field (schedule / br) ───────────────────────────────── */
  function startEditField(row: RowData, field: 'schedule' | 'br') {
    const locked = field === 'schedule' ? row.invDoc.schedule_locked : row.invDoc.br_locked
    if (locked) {
      // unlock
      saveField(row.invDoc, `${field}_locked`, false)
    }
    setEditingField({ wrId: row.wr.id!, field })
    setEditingValue(row.invDoc[field])
  }

  async function saveTextField() {
    if (!editingField) return
    const row = rows.find(r => r.wr.id === editingField.wrId)
    if (!row) return
    const { field } = editingField
    const patch: any = {
      [field]: editingValue,
      [`${field}_locked`]: editingValue.trim() !== '',
      last_modified_by: uid,
      last_modified_at: new Date().toISOString(),
    }
    await updateDoc(doc(db, 'inventory_documents', row.invDoc.id!), patch)
    updateLocalDoc(row.wr.id!, patch)
    setEditingField(null)
  }

  /* ─── File upload ───────────────────────────────────────────────────────── */
  function openUploadModal(row: RowData) {
    setUploadRow(row)
    setUploadFiles([])
    setUploadChecks(new Set())
  }

  async function doUpload() {
    if (!uploadRow || uploadFiles.length === 0) return
    if (uploadChecks.size === 0) {
      alert('Debe marcar al menos un tipo de documento que contiene este upload.')
      return
    }
    setUploading(true)
    try {
      const invDoc = uploadRow.invDoc
      const newFiles: InvDocFile[] = []
      for (const file of uploadFiles) {
        const ts = Date.now()
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        const storagePath = `seafreight/inventory-docs/${invDoc.wr_number}/${ts}_${safeName}`
        const storageRef = ref(storage, storagePath)
        await uploadBytes(storageRef, file)
        const url = await getDownloadURL(storageRef)
        newFiles.push({
          id: `${ts}_${Math.random().toString(36).slice(2, 8)}`,
          url,
          storage_path: storagePath,
          filename: file.name,
          uploaded_at: new Date().toISOString(),
          uploaded_by: uid,
        })
      }
      // Auto-check the doc types marked
      const checkPatch: any = {}
      for (const dt of uploadChecks) {
        const key = `check_${dt}` as keyof InventoryDocument
        if (!invDoc[key]) checkPatch[key] = 'check'
      }
      const patch: any = {
        files: [...invDoc.files, ...newFiles],
        ...checkPatch,
        last_modified_by: uid,
        last_modified_at: new Date().toISOString(),
      }
      await updateDoc(doc(db, 'inventory_documents', invDoc.id!), patch)
      updateLocalDoc(invDoc.wr_id, patch)
      setUploadRow(null)
    } catch (e) { console.error(e); alert('Error al subir archivos') }
    setUploading(false)
  }

  /* ─── File delete ───────────────────────────────────────────────────────── */
  async function deleteFile(row: RowData, fileId: string) {
    if (!guardEdit(row)) return
    if (!window.confirm('¿Eliminar este archivo?')) return
    const file = row.invDoc.files.find(f => f.id === fileId)
    if (!file) return
    try {
      await deleteObject(ref(storage, file.storage_path))
    } catch { /* storage file may already be gone */ }
    const newFiles = row.invDoc.files.filter(f => f.id !== fileId)
    const patch: any = {
      files: newFiles,
      last_modified_by: uid,
      last_modified_at: new Date().toISOString(),
    }
    await updateDoc(doc(db, 'inventory_documents', row.invDoc.id!), patch)
    updateLocalDoc(row.invDoc.wr_id, patch)
  }

  /* ─── Docs viewer (same pattern as AirfreightDocs) ──────────────────────── */

  function openDocsViewer(row: RowData) {
    const files = row.invDoc.files
    if (files.length === 0) { alert('No hay archivos.'); return }
    const win = window.open('', '_blank')
    if (!win) { alert('Permite ventanas emergentes.'); return }

    const isImage = (fn: string) => /\.(jpg|jpeg|png|gif|webp)$/i.test(fn)

    const embedHtml = files.map(f => {
      const titleHtml = `<h2 style="margin:0 0 8px;font-size:14px;color:#333;font-family:sans-serif;">${f.filename}</h2>`
      if (isImage(f.filename)) {
        return `<div style="margin-bottom:32px;">${titleHtml}<img src="${f.url}" style="max-width:100%;border:1px solid #ddd;border-radius:4px;" /></div>`
      }
      return `<div style="margin-bottom:32px;">${titleHtml}<iframe src="${f.url}" style="width:100%;height:80vh;border:1px solid #ddd;border-radius:4px;"></iframe></div>`
    }).join('')

    const title = `WR ${row.invDoc.wr_number} — PO ${row.invDoc.po_number}`
    win.document.write(`<!DOCTYPE html><html><head><title>${title}</title></head><body style="margin:24px;font-family:sans-serif;">
      <h1 style="font-size:16px;color:#1a3b5c;margin-bottom:16px;">${title} — ${files.length} documento${files.length > 1 ? 's' : ''}</h1>
      ${embedHtml}
    </body></html>`)
    win.document.close()
  }

  /* ─── Download Set ─────────────────────────────────────────────────────── */
  async function handleDownloadSet(row: RowData) {
    const files = row.invDoc.files
    if (files.length === 0) { alert('No hay archivos.'); return }
    setDownloadingSet(row.wr.id!)
    try {
      const pdfBuffers: ArrayBuffer[] = []
      const excelFiles: { name: string; blob: Blob }[] = []

      for (const f of files) {
        const isExcel = /\.(xlsx|xls|csv)$/i.test(f.filename)
        if (isExcel) {
          const bytes = await getBytes(ref(storage, f.storage_path))
          excelFiles.push({ name: f.filename, blob: new Blob([bytes]) })
        } else if (/\.pdf$/i.test(f.filename)) {
          const bytes = await getBytes(ref(storage, f.storage_path))
          pdfBuffers.push(bytes)
        }
      }

      // Merge and download PDFs
      if (pdfBuffers.length > 0) {
        const merged = await mergePdfBuffers(pdfBuffers.map(b => ({ buffer: b })))
        const blob = new Blob([merged], { type: 'application/pdf' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = `DOCS_${row.invDoc.wr_number}.pdf`; a.click()
        URL.revokeObjectURL(url)
      }

      // Download each Excel separately
      for (const ef of excelFiles) {
        const url = URL.createObjectURL(ef.blob)
        const a = document.createElement('a')
        a.href = url; a.download = ef.name; a.click()
        URL.revokeObjectURL(url)
      }

      if (pdfBuffers.length === 0 && excelFiles.length === 0) alert('No se encontraron PDFs ni Excel.')
    } catch (e) {
      alert('Error al descargar: ' + (e instanceof Error ? e.message : String(e)))
    }
    setDownloadingSet(null)
  }

  /* ─── Send Docs Email ────────────────────────────────────────────────────── */
  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve((reader.result as string).split(',')[1])
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  async function handleSendDocsEmail(row: RowData) {
    const files = row.invDoc.files
    if (files.length === 0) { alert('No hay archivos.'); return }
    setSendingEmail(row.wr.id!)
    try {
      // 1. Get Gmail token
      let token = gmailToken
      if (!token) {
        token = await refreshGmailToken()
        if (!token) throw new Error('No se pudo obtener autorizacion de Gmail.')
      }

      // 2. Download and separate files
      const pdfBuffers: ArrayBuffer[] = []
      const excelAttachments: { name: string; base64: string; mimeType: string }[] = []

      for (const f of files) {
        const isExcel = /\.(xlsx|xls|csv)$/i.test(f.filename)
        if (isExcel) {
          const bytes = await getBytes(ref(storage, f.storage_path))
          const blob = new Blob([bytes])
          const b64 = await blobToBase64(blob)
          const ext = f.filename.split('.').pop()?.toLowerCase()
          const mime = ext === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          excelAttachments.push({ name: f.filename, base64: b64, mimeType: mime })
        } else if (/\.pdf$/i.test(f.filename)) {
          const bytes = await getBytes(ref(storage, f.storage_path))
          pdfBuffers.push(bytes)
        }
      }

      // 3. Merge PDFs
      let pdfBase64 = ''
      if (pdfBuffers.length > 0) {
        const merged = await mergePdfBuffers(pdfBuffers.map(b => ({ buffer: b })))
        const blob = new Blob([merged], { type: 'application/pdf' })
        pdfBase64 = await blobToBase64(blob)
      }

      // 4. Resolve recipients from clients
      let recipients: { name: string; email: string }[] = []
      if (row.invDoc.client_name) {
        const clSnap = await getDocs(query(collection(db, 'clients'), where('name', '==', row.invDoc.client_name)))
        for (const d of clSnap.docs) {
          const client = d.data() as Client
          for (const r of client.email_recipients || []) {
            if (!r.notify_docs || !r.email) continue
            if (r.destination && row.invDoc.country && r.destination !== row.invDoc.country) continue
            recipients.push({ name: r.name, email: r.email })
          }
        }
      }
      const seen = new Set<string>()
      recipients = recipients.filter(r => { if (seen.has(r.email)) return false; seen.add(r.email); return true })
      if (recipients.length === 0) { alert('No hay destinatarios con notify_docs activo para este cliente.'); setSendingEmail(null); return }

      // 5. Resolve CC
      let ccList = MCL_CC_RECIPIENTS
      const ccSnap = await getDocs(query(collection(db, 'config'), where('__name__', '==', 'email_settings')))
      if (ccSnap.docs.length > 0 && ccSnap.docs[0].data().mcl_cc_recipients?.length) {
        ccList = ccSnap.docs[0].data().mcl_cc_recipients
      }

      // 6. Build MIME
      const boundary = 'MCL_DOCS_' + Date.now()
      const to = recipients.map(r => r.email).join(', ')
      const cc = ccList.map((r: any) => r.email).join(', ')
      const subject = `Documentos ${row.invDoc.wr_number} - PO ${row.invDoc.po_number}`
      const bodyText = `Estimados,\n\nAdjunto set de documentos del WR ${row.invDoc.wr_number} (PO ${row.invDoc.po_number}).\n\nMuchas gracias,\nMinCurl Logistics`

      const mimeParts: string[] = [
        `MIME-Version: 1.0`, `To: ${to}`, `Cc: ${cc}`, `Subject: ${subject}`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`, ``,
        `--${boundary}`, `Content-Type: text/plain; charset=UTF-8`, ``, bodyText, ``,
      ]
      if (pdfBase64) {
        mimeParts.push(`--${boundary}`, `Content-Type: application/pdf`, `Content-Transfer-Encoding: base64`,
          `Content-Disposition: attachment; filename="DOCS_${row.invDoc.wr_number}.pdf"`, ``, pdfBase64, ``)
      }
      for (const att of excelAttachments) {
        mimeParts.push(`--${boundary}`, `Content-Type: ${att.mimeType}`, `Content-Transfer-Encoding: base64`,
          `Content-Disposition: attachment; filename="${att.name}"`, ``, att.base64, ``)
      }
      mimeParts.push(`--${boundary}--`)
      const rawMime = mimeParts.join('\r\n')

      // 7. Create Gmail draft via upload endpoint (supports large attachments up to 35MB)
      async function createDraft(t: string): Promise<string> {
        const mimeBytes = new TextEncoder().encode(rawMime)
        const metaJson = JSON.stringify({ message: {} })
        const uploadBoundary = 'UPLOAD_' + Date.now()
        const parts = [
          `--${uploadBoundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n`,
          `--${uploadBoundary}\r\nContent-Type: message/rfc822\r\n\r\n`,
        ]
        const prefix = new TextEncoder().encode(parts[0] + parts[1])
        const suffix = new TextEncoder().encode(`\r\n--${uploadBoundary}--`)
        const body = new Uint8Array(prefix.length + mimeBytes.length + suffix.length)
        body.set(prefix, 0)
        body.set(mimeBytes, prefix.length)
        body.set(suffix, prefix.length + mimeBytes.length)

        const res = await fetch('https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=multipart', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${t}`,
            'Content-Type': `multipart/related; boundary="${uploadBoundary}"`,
          },
          body,
        })
        if (!res.ok) {
          const err = await res.json()
          throw new Error(err?.error?.message || 'Gmail API error')
        }
        const data = await res.json()
        return data.id
      }

      let draftId: string
      try {
        draftId = await createDraft(token)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : ''
        if (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('expired') || msg.toLowerCase().includes('401')) {
          const fresh = await refreshGmailToken()
          if (!fresh) throw new Error('Sesion de Gmail expirada. Recarga la pagina.')
          draftId = await createDraft(fresh)
        } else throw err
      }

      window.open(`https://mail.google.com/mail/u/0/#drafts?compose=${draftId}`, '_blank')
      alert(`Borrador creado. Se abrio Gmail para revisar y enviar.\nDestinatarios: ${recipients.map(r => r.name).join(', ')}`)
    } catch (e) {
      alert('Error al enviar: ' + (e instanceof Error ? e.message : String(e)))
    }
    setSendingEmail(null)
  }

  /* ─── Comments ──────────────────────────────────────────────────────────── */
  async function addComment() {
    if (!commentsRow || !commentText.trim()) return
    const invDoc = commentsRow.invDoc
    const newComment: InvDocComment = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text: commentText.trim(),
      user_name: uid,
      user_id: user?.uid || '',
      created_at: new Date().toISOString(),
      deleted: false,
    }
    const patch: any = {
      comments: [...invDoc.comments, newComment],
      last_modified_by: uid,
      last_modified_at: new Date().toISOString(),
    }
    await updateDoc(doc(db, 'inventory_documents', invDoc.id!), patch)
    updateLocalDoc(invDoc.wr_id, patch)
    setCommentText('')
  }

  async function deleteComment(row: RowData, commentId: string) {
    const invDoc = row.invDoc
    const newComments = invDoc.comments.map(c =>
      c.id === commentId ? { ...c, deleted: true, deleted_by: uid, deleted_at: new Date().toISOString() } : c
    )
    const patch: any = {
      comments: newComments,
      last_modified_by: uid,
      last_modified_at: new Date().toISOString(),
    }
    await updateDoc(doc(db, 'inventory_documents', invDoc.id!), patch)
    updateLocalDoc(invDoc.wr_id, patch)
  }

  /* ─── Filters ───────────────────────────────────────────────────────────── */
  const clientNames = [...new Set(rows.map(r => r.invDoc.client_name).filter(Boolean))].sort()
  const countries = [...new Set(rows.map(r => r.invDoc.country).filter(Boolean))].sort()

  const filtered = rows.filter(r => {
    if (filterClient && r.invDoc.client_name !== filterClient) return false
    if (filterCountry && r.invDoc.country !== filterCountry) return false
    if (filterStatus === 'warehouse' && (r.wr.dispatch_status === 'dispatched' || r.wr.dispatch_status === 'reserved')) return false
    if (filterStatus === 'reserved' && r.wr.dispatch_status !== 'reserved') return false
    if (filterStatus === 'gateout' && r.wr.dispatch_status !== 'dispatched') return false
    if (filterBooking) {
      const b = filterBooking.toLowerCase()
      if (!(r.dispatch?.booking_number || '').toLowerCase().includes(b)) return false
    }
    if (filterBookingLI) {
      const b = filterBookingLI.toLowerCase()
      if (!(r.dispatch?.booking_request_li || '').toLowerCase().includes(b)) return false
    }
    if (search) {
      const s = search.toLowerCase()
      if (!r.invDoc.wr_number.toLowerCase().includes(s) &&
          !r.invDoc.po_number.toLowerCase().includes(s) &&
          !r.invDoc.vendor.toLowerCase().includes(s)) return false
    }
    return true
  })

  const selectClass = 'border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/30 bg-white'

  return (
    <Layout title="Inventario - Documentos" backTo="/inventory">
      {/* Top buttons */}
      <div className="flex justify-end gap-2 mb-3">
        <button onClick={() => navigate('/inventory')}
          className="flex items-center gap-2 bg-gray-500 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-gray-600 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
          </svg>
          Inventario
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input type="text" placeholder="Buscar WR, PO, Vendor..." value={search}
            onChange={e => setSearch(e.target.value)} className={selectClass + ' w-full'} />
          <input type="text" placeholder="Booking..." value={filterBooking}
            onChange={e => setFilterBooking(e.target.value)} className={selectClass + ' w-full'} />
          <input type="text" placeholder="Booking Request LI..." value={filterBookingLI}
            onChange={e => setFilterBookingLI(e.target.value)} className={selectClass + ' w-full'} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
          {!isClient && (
            <select value={filterClient} onChange={e => setFilterClient(e.target.value)} className={selectClass}>
              <option value="">Todos los clientes</option>
              {clientNames.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <select value={filterCountry} onChange={e => setFilterCountry(e.target.value)} className={selectClass}>
            <option value="">Todos los paises</option>
            {countries.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)} className={selectClass}>
            <option value="">Todos</option>
            <option value="warehouse">En Bodega</option>
            <option value="reserved">Reservados</option>
            <option value="gateout">Gate Out</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue mx-auto" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No hay documentos de inventario.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 uppercase w-7"></th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-600 uppercase">WR #</th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-600 uppercase">PO #</th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-600 uppercase hidden md:table-cell">Vendor</th>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 uppercase">Pais</th>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 uppercase hidden sm:table-cell">Tipo</th>
                  <th className="text-right px-1 py-2 font-semibold text-gray-600 uppercase">Pzas</th>
                  <th className="text-right px-1 py-2 font-semibold text-gray-600 uppercase hidden sm:table-cell">CBM</th>
                  <th className="text-right px-1 py-2 font-semibold text-gray-600 uppercase hidden sm:table-cell">KG</th>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 uppercase" style={{minWidth:'80px'}}>Schedule</th>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 uppercase w-10">SLI</th>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 uppercase w-10">PL</th>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 uppercase w-10">INV</th>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 uppercase w-10">CO</th>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 uppercase w-10">MC</th>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 uppercase w-10">7512</th>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 uppercase w-10">DREB</th>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 uppercase" style={{minWidth:'80px'}}>BR</th>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 uppercase w-10">
                    <svg className="w-4 h-4 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                    </svg>
                  </th>
                  <th className="px-1 py-2 w-20"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(row => {
                  const d = row.invDoc
                  const sem = getDocSemaphore(d)
                  const locked = isLocked(row)
                  return (
                    <tr key={d.wr_id} className={`border-t border-gray-50 hover:bg-gray-50 transition-colors ${locked ? 'opacity-60' : ''}`}>
                      {/* Semaphore */}
                      <td className="px-1 py-2 text-center">
                        <div className={`w-3 h-3 rounded-full mx-auto ${semaphoreClasses(sem)}`}
                          title={sem === 'blue' ? 'Completo' : sem === 'yellow' ? 'Parcial' : 'Sin docs'} />
                      </td>
                      <td className="px-2 py-2 font-mono font-semibold text-mcl-blue">{d.wr_number}</td>
                      <td className="px-2 py-2 text-gray-700">{d.po_number}</td>
                      <td className="px-2 py-2 text-gray-600 hidden md:table-cell max-w-[120px] truncate">{toTitleCase(d.vendor)}</td>
                      <td className="px-1 py-2 text-center">
                        <span className="inline-block bg-mcl-blue/10 text-mcl-blue font-bold px-1.5 py-0.5 rounded">{d.country}</span>
                      </td>
                      <td className="px-1 py-2 text-center hidden sm:table-cell">
                        {d.cargo_type && (
                          <span className={`font-bold px-1 py-0.5 rounded ${d.cargo_type === 'BOND' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                            {d.cargo_type}
                          </span>
                        )}
                      </td>
                      <td className="px-1 py-2 text-right font-semibold text-gray-700">{fmtNum(d.total_pieces)}</td>
                      <td className="px-1 py-2 text-right text-gray-500 font-mono hidden sm:table-cell">{fmtNum(d.total_cbm, 4)}</td>
                      <td className="px-1 py-2 text-right text-gray-500 hidden sm:table-cell">{fmtNum(d.total_kg)}</td>

                      {/* Schedule (lockable text) */}
                      <td className="px-1 py-2 text-center" onClick={e => e.stopPropagation()}>
                        {editingField?.wrId === d.wr_id && editingField.field === 'schedule' ? (
                          <div className="flex items-center gap-1">
                            <input type="text" value={editingValue} onChange={e => setEditingValue(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') saveTextField(); if (e.key === 'Escape') setEditingField(null) }}
                              autoFocus className="border border-mcl-blue rounded px-1 py-0.5 text-xs w-full focus:outline-none" />
                            <button onClick={saveTextField}
                              className="w-5 h-5 rounded-full bg-green-500 text-white flex items-center justify-center flex-shrink-0">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                              </svg>
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 justify-center group/sf cursor-pointer"
                            onClick={() => startEditField(row, 'schedule')}>
                            <span className={`text-xs ${d.schedule_locked ? 'font-semibold text-gray-700' : 'text-gray-400 italic'}`}>
                              {d.schedule || '—'}
                            </span>
                            {d.schedule_locked && (
                              <svg className="w-3 h-3 text-gray-300 opacity-0 group-hover/sf:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                              </svg>
                            )}
                          </div>
                        )}
                      </td>

                      {/* SLI / PL / INV / CO / MC checks */}
                      {(['check_sli', 'check_pl', 'check_inv', 'check_co', 'check_mc'] as const).map(key => {
                        const disp = checkDisplay(d[key])
                        return (
                          <td key={key} className="px-1 py-2 text-center">
                            <button onClick={() => toggleCheck(row, key)}
                              className={`w-7 h-7 rounded text-xs flex items-center justify-center mx-auto border border-gray-200 hover:border-mcl-blue transition-colors ${disp.cls}`}>
                              {disp.text || <span className="text-gray-300">—</span>}
                            </button>
                          </td>
                        )
                      })}

                      {/* 7512 — only for BONDED cargo, alarm if missing */}
                      <td className="px-1 py-2 text-center">
                        {d.cargo_type === 'BOND' ? (() => {
                          const disp7512 = checkDisplay(d.check_7512)
                          const isMissing = d.check_7512 === null || d.check_7512 === undefined
                          return (
                            <button onClick={() => toggleCheck(row, 'check_7512')}
                              className={`w-7 h-7 rounded text-xs flex items-center justify-center mx-auto border transition-colors ${
                                isMissing
                                  ? 'bg-red-100 border-red-400 text-red-600 font-bold animate-pulse'
                                  : `${disp7512.cls} border-gray-200 hover:border-mcl-blue`
                              }`}
                              title={isMissing ? 'ALERTA: Documento 7512 pendiente' : '7512'}>
                              {isMissing ? '!' : disp7512.text || <span className="text-gray-300">—</span>}
                            </button>
                          )
                        })() : (
                          <span className="text-gray-200">—</span>
                        )}
                      </td>

                      {/* DREB check */}
                      <td className="px-1 py-2 text-center">
                        {(() => {
                          const dispDreb = checkDisplay(d.check_dreb)
                          return (
                            <button onClick={() => toggleCheck(row, 'check_dreb')}
                              className={`w-7 h-7 rounded text-xs flex items-center justify-center mx-auto border border-gray-200 hover:border-mcl-blue transition-colors ${dispDreb.cls}`}>
                              {dispDreb.text || <span className="text-gray-300">—</span>}
                            </button>
                          )
                        })()}
                      </td>

                      {/* BR (lockable text) */}
                      <td className="px-1 py-2 text-center" onClick={e => e.stopPropagation()}>
                        {editingField?.wrId === d.wr_id && editingField.field === 'br' ? (
                          <div className="flex items-center gap-1">
                            <input type="text" value={editingValue} onChange={e => setEditingValue(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') saveTextField(); if (e.key === 'Escape') setEditingField(null) }}
                              autoFocus className="border border-mcl-blue rounded px-1 py-0.5 text-xs w-full focus:outline-none" />
                            <button onClick={saveTextField}
                              className="w-5 h-5 rounded-full bg-green-500 text-white flex items-center justify-center flex-shrink-0">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                              </svg>
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 justify-center group/br cursor-pointer"
                            onClick={() => startEditField(row, 'br')}>
                            <span className={`text-xs ${d.br_locked ? 'font-semibold text-gray-700' : 'text-gray-400 italic'}`}>
                              {d.br || '—'}
                            </span>
                            {d.br_locked && (
                              <svg className="w-3 h-3 text-gray-300 opacity-0 group-hover/br:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                              </svg>
                            )}
                          </div>
                        )}
                      </td>

                      {/* Comments badge */}
                      <td className="px-1 py-2 text-center">
                        <button onClick={() => setCommentsRow(row)}
                          className="relative text-gray-400 hover:text-mcl-blue transition-colors">
                          <svg className="w-4 h-4 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                          </svg>
                          {d.comments.filter(c => !c.deleted).length > 0 && (
                            <span className="absolute -top-1 -right-1 bg-mcl-blue text-white text-[8px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center">
                              {d.comments.filter(c => !c.deleted).length}
                            </span>
                          )}
                        </button>
                      </td>

                      {/* Actions */}
                      <td className="px-1 py-2">
                        <div className="flex items-center gap-1 justify-center">
                          {/* Upload */}
                          <button onClick={() => openUploadModal(row)}
                            className="text-gray-400 hover:text-green-600 transition-colors" title="Subir archivos">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                            </svg>
                          </button>
                          {/* Files list */}
                          <button onClick={() => setFilesRow(row)}
                            className="relative text-gray-400 hover:text-amber-600 transition-colors" title="Ver archivos">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            {d.files.length > 0 && (
                              <span className="absolute -top-1 -right-1 bg-amber-500 text-white text-[8px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center">
                                {d.files.length}
                              </span>
                            )}
                          </button>
                          {/* Download set */}
                          <button onClick={() => handleDownloadSet(row)}
                            disabled={d.files.length === 0 || downloadingSet === row.wr.id}
                            className={`text-gray-400 transition-colors ${d.files.length > 0 ? 'hover:text-purple-600' : 'opacity-30 cursor-not-allowed'}`}
                            title="Descargar Set">
                            {downloadingSet === row.wr.id ? (
                              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                              </svg>
                            ) : (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                              </svg>
                            )}
                          </button>
                          {/* Email docs */}
                          <button onClick={() => handleSendDocsEmail(row)}
                            disabled={d.files.length === 0 || sendingEmail === row.wr.id}
                            className={`text-gray-400 transition-colors ${d.files.length > 0 ? 'hover:text-green-600' : 'opacity-30 cursor-not-allowed'}`}
                            title="Enviar por Email">
                            {sendingEmail === row.wr.id ? (
                              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                              </svg>
                            ) : (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                              </svg>
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Upload Modal ──────────────────────────────────────────────────── */}
      {uploadRow && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => !uploading && setUploadRow(null)} />
          <div className="relative bg-white rounded-t-2xl sm:rounded-2xl shadow-xl w-full sm:max-w-md max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <p className="font-bold text-gray-800">Subir Documentos</p>
                <p className="text-xs text-gray-400 font-mono">{uploadRow.invDoc.wr_number} · {uploadRow.invDoc.po_number}</p>
              </div>
              <button onClick={() => !uploading && setUploadRow(null)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
              {/* File input */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-2">Archivos (PDF, Excel, Imagenes)</label>
                <input type="file" multiple accept=".pdf,.xlsx,.xls,.csv,.png,.jpg,.jpeg,.gif,.webp"
                  onChange={e => setUploadFiles(Array.from(e.target.files || []))}
                  className="w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-mcl-blue/10 file:text-mcl-blue hover:file:bg-mcl-blue/20" />
                {uploadFiles.length > 0 && (
                  <p className="text-xs text-gray-400 mt-1">{uploadFiles.length} archivo(s) seleccionado(s)</p>
                )}
              </div>
              {/* Doc type checks */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-2">Este upload contiene:</label>
                <div className="flex flex-wrap gap-2">
                  {DOC_TYPES.filter(dt => dt !== '7512' || uploadRow.invDoc.cargo_type === 'BOND').map(dt => (
                    <label key={dt}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium cursor-pointer border transition-colors
                        ${uploadChecks.has(dt) ? 'bg-green-100 border-green-400 text-green-700' : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'}`}>
                      <input type="checkbox" checked={uploadChecks.has(dt)}
                        onChange={() => {
                          const next = new Set(uploadChecks)
                          next.has(dt) ? next.delete(dt) : next.add(dt)
                          setUploadChecks(next)
                        }}
                        className="rounded" />
                      {DOC_LABELS[dt]}
                    </label>
                  ))}
                </div>
              </div>
              <button onClick={doUpload} disabled={uploadFiles.length === 0 || uploading}
                className="w-full bg-green-600 text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-green-700 transition-colors disabled:opacity-40">
                {uploading ? 'Subiendo...' : 'Subir archivos'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Files Drawer ──────────────────────────────────────────────────── */}
      {filesRow && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setFilesRow(null)} />
          <div className="relative bg-white rounded-t-2xl sm:rounded-2xl shadow-xl w-full sm:max-w-lg max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <p className="font-bold text-gray-800">Archivos</p>
                <p className="text-xs text-gray-400 font-mono">{filesRow.invDoc.wr_number} · {filesRow.invDoc.po_number}</p>
              </div>
              <div className="flex items-center gap-2">
                {filesRow.invDoc.files.length > 1 && (
                  <button
                    onClick={() => {
                      for (const f of filesRow.invDoc.files) {
                        const a = document.createElement('a')
                        a.href = f.url
                        a.target = '_blank'
                        a.rel = 'noopener noreferrer'
                        a.download = f.filename
                        document.body.appendChild(a)
                        a.click()
                        document.body.removeChild(a)
                      }
                    }}
                    className="flex items-center gap-1 text-xs font-semibold text-mcl-blue hover:text-blue-700 bg-blue-50 px-3 py-1.5 rounded-lg transition-colors"
                    title="Descargar todos los archivos"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Descargar todos
                  </button>
                )}
                <button onClick={() => setFilesRow(null)} className="text-gray-400 hover:text-gray-600">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="overflow-y-auto flex-1 px-5 py-4">
              {filesRow.invDoc.files.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">No hay archivos.</p>
              ) : (
                <div className="space-y-2">
                  {filesRow.invDoc.files.map(f => (
                    <div key={f.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-700 truncate">{f.filename}</p>
                        <p className="text-xs text-gray-400">{f.uploaded_by} · {formatWRDate(f.uploaded_at)}</p>
                      </div>
                      <div className="flex items-center gap-1.5 ml-2 flex-shrink-0">
                        <a href={f.url} target="_blank" rel="noopener noreferrer"
                          className="text-mcl-blue hover:text-blue-700 transition-colors" title="Ver/Descargar">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                        </a>
                        {(!isLocked(filesRow) || canOverrideLock()) && (
                          <button onClick={() => deleteFile(filesRow, f.id)}
                            className="text-gray-300 hover:text-red-500 transition-colors" title="Eliminar">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Comments Drawer ───────────────────────────────────────────────── */}
      {commentsRow && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setCommentsRow(null)} />
          <div className="relative bg-white rounded-t-2xl sm:rounded-2xl shadow-xl w-full sm:max-w-md max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <p className="font-bold text-gray-800">Comentarios</p>
                <p className="text-xs text-gray-400 font-mono">{commentsRow.invDoc.wr_number} · {commentsRow.invDoc.po_number}</p>
              </div>
              <button onClick={() => setCommentsRow(null)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-2" style={{ maxHeight: '50vh' }}>
              {commentsRow.invDoc.comments.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">Sin comentarios.</p>
              ) : (
                commentsRow.invDoc.comments.map(c => (
                  <div key={c.id} className={`rounded-lg px-3 py-2 text-sm ${c.deleted ? 'bg-gray-50 italic' : 'bg-blue-50'}`}>
                    {c.deleted ? (
                      <p className="text-gray-400 text-xs">
                        <svg className="w-3 h-3 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                        </svg>
                        {c.deleted_by} elimino este mensaje
                      </p>
                    ) : (
                      <>
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="font-semibold text-mcl-blue text-xs">{c.user_name}</span>
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-gray-400">{formatWRDate(c.created_at)}</span>
                            <button onClick={() => deleteComment(commentsRow, c.id)}
                              className="text-gray-300 hover:text-red-500 transition-colors" title="Eliminar">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        </div>
                        <p className="text-gray-700">{c.text}</p>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
            {/* Input */}
            <div className="px-5 py-3 border-t border-gray-100 flex items-center gap-2">
              <input type="text" value={commentText} onChange={e => setCommentText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addComment() }}
                placeholder="Escribe un comentario..."
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/30" />
              <button onClick={addComment} disabled={!commentText.trim()}
                className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors disabled:opacity-40">
                Enviar
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
