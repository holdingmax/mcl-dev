import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, query, getDocs, orderBy, doc, updateDoc, limit } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import html2pdf from 'html2pdf.js'

// ── Types ──

interface InvoiceCharge {
  id: string
  service_type: string
  description: string
  amount: number
  storage_days?: number | null
  qty?: number | null
  rate_price?: number | null
  rate_unit?: string | null
  detail?: string | null
}

interface WSInvoice {
  id: string
  invoice_number: string
  so_id: string
  so_number: string
  client_id: string
  client_name: string
  client_legal_name: string
  client_address: string
  awb_number: string | null
  wr_number: string | null
  cargo_type: string | null
  cargo_mode: string | null
  reference: string | null
  received_at: string | null
  completed_at: string | null
  charges: InvoiceCharge[]
  charge_ids: string[]
  subtotal: number
  discount: number
  total: number
  currency: string
  payment_terms: string
  payment_terms_days: number
  status: 'draft' | 'issued' | 'paid' | 'void'
  issued_at?: string
  paid_at?: string
  voided_at?: string
  created_at: string
  created_by: string
}

// ── Helpers ──

function fmtUSD(n: number) { return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '\u2014'
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso)
  d.setDate(d.getDate() + days)
  return d.toISOString()
}

const SERVICE_LABELS: Record<string, string> = {
  in_out: 'In/Out Cargo',
  storage: 'Storage',
  screening_k9: 'K9 Screening',
  screening_xray: 'X-Ray Screening',
  screening_manual: 'Screening Special Cargo',
  transport: 'Transport',
  dg_inspection: 'DG Acceptance',
  repack: 'Repack',
  bonded_fee: 'Bonded Fee',
}

const CARGO_TYPE_LABELS: Record<string, string> = {
  GENERAL: 'General',
  SPECIAL: 'Special Cargo',
  DG: 'Dangerous Goods',
}

const CARGO_MODE_LABELS: Record<string, string> = {
  LOC: 'Local',
  BOND: 'Bonded',
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  issued: 'bg-blue-100 text-blue-700',
  paid: 'bg-green-100 text-green-700',
  void: 'bg-red-100 text-red-600',
}

// ── Component ──

export default function WSInvoices() {
  const navigate = useNavigate()
  const { isAdmin, isAccounting } = useAuth()
  const [invoices, setInvoices] = useState<WSInvoice[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [filterClient, setFilterClient] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [viewInvoice, setViewInvoice] = useState<WSInvoice | null>(null)
  const [editInvoice, setEditInvoice] = useState<{ invoice_number: string; client_name: string; client_legal_name: string; client_address: string; payment_terms: string; payment_terms_days: number; due_date: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const printRef = useRef<HTMLDivElement>(null)
  const canEditInvoice = isAdmin || isAccounting

  useEffect(() => { loadInvoices() }, [])

  async function loadInvoices() {
    setLoading(true)
    try {
      const snap = await getDocs(query(collection(db, 'ws_invoices'), orderBy('created_at', 'desc'), limit(500)))
      setInvoices(snap.docs.map(d => ({ id: d.id, ...d.data() } as WSInvoice)))
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  // ── Edit invoice ──
  function startEdit(inv: WSInvoice) {
    const dueDate = (inv as any).due_date
      || (inv.completed_at ? addDays(inv.completed_at, inv.payment_terms_days || 30)
      : inv.received_at ? addDays(inv.received_at, inv.payment_terms_days || 30)
      : inv.issued_at ? addDays(inv.issued_at, inv.payment_terms_days || 30) : '')
    setEditInvoice({
      invoice_number: inv.invoice_number,
      client_name: inv.client_name,
      client_legal_name: inv.client_legal_name || '',
      client_address: inv.client_address || '',
      payment_terms: inv.payment_terms || 'Net 30',
      payment_terms_days: inv.payment_terms_days || 30,
      due_date: dueDate ? dueDate.slice(0, 10) : '',
    })
  }

  async function saveEdit() {
    if (!viewInvoice || !editInvoice) return
    setSaving(true)
    try {
      const updates: Record<string, any> = {
        invoice_number: editInvoice.invoice_number.trim(),
        client_name: editInvoice.client_name.trim(),
        client_legal_name: editInvoice.client_legal_name.trim(),
        client_address: editInvoice.client_address.trim(),
        payment_terms: editInvoice.payment_terms.trim(),
        payment_terms_days: editInvoice.payment_terms_days,
        due_date: editInvoice.due_date || null,
      }
      await updateDoc(doc(db, 'ws_invoices', viewInvoice.id), updates)
      // Update billing charges if invoice_number changed
      if (editInvoice.invoice_number.trim() !== viewInvoice.invoice_number) {
        for (const chId of viewInvoice.charge_ids) {
          await updateDoc(doc(db, 'ws_billing_charges', chId), { invoice_number: editInvoice.invoice_number.trim() })
        }
      }
      setEditInvoice(null)
      await loadInvoices()
      setViewInvoice({ ...viewInvoice, ...updates } as WSInvoice)
    } catch (e) { alert('Error guardando: ' + String(e)) }
    setSaving(false)
  }

  // ── Toggle sent to client ──
  async function handleToggleSent(inv: WSInvoice) {
    const newVal = !(inv as any).sent_to_client
    try {
      await updateDoc(doc(db, 'ws_invoices', inv.id), {
        sent_to_client: newVal,
        ...(newVal ? { sent_at: new Date().toISOString() } : { sent_at: null }),
      })
      setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, sent_to_client: newVal, sent_at: newVal ? new Date().toISOString() : null } as any : i))
    } catch (e) { alert('Error: ' + String(e)) }
  }

  // ── Status actions ──
  async function handleMarkPaid(inv: WSInvoice) {
    if (!confirm(`Marcar ${inv.invoice_number} como PAID?`)) return
    try {
      await updateDoc(doc(db, 'ws_invoices', inv.id), { status: 'paid', paid_at: new Date().toISOString() })
      // Also update charges
      for (const chId of inv.charge_ids) {
        await updateDoc(doc(db, 'ws_billing_charges', chId), { status: 'paid' })
      }
      await loadInvoices()
      if (viewInvoice?.id === inv.id) setViewInvoice({ ...inv, status: 'paid' })
    } catch (e) { alert('Error: ' + String(e)) }
  }

  async function handleRevertToIssued(inv: WSInvoice) {
    if (!confirm(`Revertir ${inv.invoice_number} a ISSUED?`)) return
    try {
      await updateDoc(doc(db, 'ws_invoices', inv.id), { status: 'issued', paid_at: null })
      for (const chId of inv.charge_ids) {
        await updateDoc(doc(db, 'ws_billing_charges', chId), { status: 'invoiced' })
      }
      await loadInvoices()
      if (viewInvoice?.id === inv.id) setViewInvoice({ ...inv, status: 'issued' })
    } catch (e) { alert('Error: ' + String(e)) }
  }

  async function handleVoid(inv: WSInvoice) {
    if (!confirm(`ANULAR factura ${inv.invoice_number}?\n\nLos cargos volveran a estado pending.`)) return
    try {
      await updateDoc(doc(db, 'ws_invoices', inv.id), { status: 'void', voided_at: new Date().toISOString() })
      for (const chId of inv.charge_ids) {
        await updateDoc(doc(db, 'ws_billing_charges', chId), { status: 'pending', invoice_id: null, invoice_number: null })
      }
      // Revert SO status
      await updateDoc(doc(db, 'warehouse_service_orders', inv.so_id), { global_status: 'completed', billed_at: null })
      await loadInvoices()
      if (viewInvoice?.id === inv.id) setViewInvoice({ ...inv, status: 'void' })
    } catch (e) { alert('Error: ' + String(e)) }
  }

  // ── PDF ──
  async function handleDownloadPdf(inv: WSInvoice) {
    setViewInvoice(inv)
    // Wait for render
    await new Promise(r => setTimeout(r, 300))
    const el = printRef.current
    if (!el) { alert('Error: no se pudo generar el PDF'); return }
    try {
      await html2pdf().set({
        margin: [4, 4],
        filename: `${inv.invoice_number}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'letter', orientation: 'portrait' },
        pagebreak: { mode: 'avoid-all' },
      }).from(el).save()
    } catch (e) {
      console.error(e)
      alert('Error generando PDF: ' + String(e))
    }
  }

  // ── Derived: unique clients ──
  const clientOptions = Array.from(new Set(invoices.map(i => i.client_name))).sort()

  // ── Filter ──
  const filtered = invoices.filter(inv => {
    if (filterStatus === 'sent' && !(inv as any).sent_to_client) return false
    if (filterStatus === 'not_sent' && (inv as any).sent_to_client) return false
    if (filterStatus && filterStatus !== 'sent' && filterStatus !== 'not_sent' && inv.status !== filterStatus) return false
    if (filterClient && inv.client_name !== filterClient) return false
    if (dateFrom || dateTo) {
      const invDate = (inv.issued_at || inv.created_at || '').slice(0, 10)
      if (dateFrom && invDate < dateFrom) return false
      if (dateTo && invDate > dateTo) return false
    }
    if (search) {
      const s = search.toLowerCase()
      if (!inv.invoice_number.toLowerCase().includes(s) && !inv.client_name.toLowerCase().includes(s) && !inv.so_number.toLowerCase().includes(s)) return false
    }
    return true
  })

  if (!isAdmin && !isAccounting) {
    return (
      <Layout title="Invoices" backTo="/warehouse-services/admin">
        <p className="text-center text-gray-500 mt-10">Access restricted to Admin / Accounting</p>
      </Layout>
    )
  }

  return (
    <Layout title="WS Invoices" backTo="/warehouse-services/admin">
      <div className="max-w-6xl mx-auto space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar invoice, cliente, SO..."
            className="flex-1 min-w-[200px] border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
          />
          <select value={filterClient} onChange={e => setFilterClient(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
            <option value="">Todos los clientes</option>
            {clientOptions.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
            <option value="">Todos</option>
            <option value="issued">Issued</option>
            <option value="sent">Enviada</option>
            <option value="not_sent">No enviada</option>
            <option value="paid">Paid</option>
            <option value="void">Void</option>
          </select>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" title="Desde" />
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" title="Hasta" />
        </div>

        {/* Summary bar */}
        <div className="bg-[#0a1929] text-white rounded-xl px-6 py-3 flex items-center justify-between">
          <span className="text-sm">{filtered.length} factura{filtered.length !== 1 ? 's' : ''}</span>
          <span className="text-lg font-bold">
            Total: {fmtUSD(filtered.filter(i => i.status !== 'void').reduce((s, i) => s + i.total, 0))} USD
          </span>
        </div>

        {loading ? (
          <p className="text-center text-gray-400 py-10">Loading...</p>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
            <p className="text-gray-400">No hay facturas</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Invoice #</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">SO</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Client</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600">Total</th>
                  <th className="text-center px-4 py-2.5 font-medium text-gray-600">Status</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Date</th>
                  <th className="text-center px-4 py-2.5 font-medium text-gray-600 w-40">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(inv => (
                  <tr key={inv.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-mono text-sm font-bold text-mcl-blue">{inv.invoice_number}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-600">{inv.so_number}</td>
                    <td className="px-4 py-2.5">{inv.client_name}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold">{fmtUSD(inv.total)}</td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[inv.status] || 'bg-gray-100 text-gray-600'}`}>
                        {inv.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{fmtDate(inv.issued_at || inv.created_at)}</td>
                    <td className="px-4 py-2.5 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => setViewInvoice(inv)}
                          className="text-gray-400 hover:text-mcl-blue p-1"
                          title="Ver"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        </button>
                        <button
                          onClick={() => handleDownloadPdf(inv)}
                          className="text-gray-400 hover:text-green-600 p-1"
                          title="Descargar PDF"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        </button>
                        <button
                          onClick={() => handleToggleSent(inv)}
                          className={`p-1 ${(inv as any).sent_to_client ? 'text-green-600' : 'text-gray-400 hover:text-green-600'}`}
                          title={(inv as any).sent_to_client ? 'Enviada al cliente' : 'Marcar como enviada'}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <rect x="2" y="4" width="20" height="16" rx="2" />
                            <path d="M22 4L12 13 2 4" />
                            {(inv as any).sent_to_client && <path d="M15 14l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />}
                          </svg>
                        </button>
                        {(inv.status === 'issued' || inv.status === 'paid') && (
                          <button
                            onClick={() => inv.status === 'paid' ? handleRevertToIssued(inv) : handleMarkPaid(inv)}
                            className={`p-1 ${inv.status === 'paid' ? 'text-green-600 hover:text-gray-400' : 'text-gray-400 hover:text-green-600'}`}
                            title={inv.status === 'paid' ? 'Revertir a Issued' : 'Marcar como Paid'}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          </button>
                        )}
                        {inv.status === 'issued' && (
                          <button
                            onClick={() => handleVoid(inv)}
                            className="text-gray-400 hover:text-red-500 p-1"
                            title="Anular"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ══ Invoice detail/preview modal ══ */}
      {viewInvoice && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto">
          <div className="absolute inset-0 bg-black/40" onClick={() => setViewInvoice(null)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-3xl my-8">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <div className="flex items-center gap-3">
                <h3 className="font-bold text-gray-800">{viewInvoice.invoice_number}</h3>
                <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[viewInvoice.status]}`}>
                  {viewInvoice.status.toUpperCase()}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {canEditInvoice && !editInvoice && (
                  <button
                    onClick={() => startEdit(viewInvoice)}
                    className="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold px-4 py-1.5 rounded-lg transition-colors"
                  >
                    Editar
                  </button>
                )}
                <button
                  onClick={() => handleDownloadPdf(viewInvoice)}
                  className="text-sm bg-green-600 hover:bg-green-700 text-white font-semibold px-4 py-1.5 rounded-lg transition-colors"
                >
                  Descargar PDF
                </button>
                {viewInvoice.status === 'issued' && (
                  <>
                    <button onClick={() => handleMarkPaid(viewInvoice)} className="text-sm bg-blue-600 hover:bg-blue-700 text-white font-semibold px-4 py-1.5 rounded-lg transition-colors">
                      Mark Paid
                    </button>
                    <button onClick={() => handleVoid(viewInvoice)} className="text-sm bg-red-500 hover:bg-red-600 text-white font-semibold px-4 py-1.5 rounded-lg transition-colors">
                      Void
                    </button>
                  </>
                )}
                <button onClick={() => { setViewInvoice(null); setEditInvoice(null) }} className="text-gray-400 hover:text-gray-600 p-1">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>

            {/* Edit form */}
            {editInvoice && (
              <div className="px-6 py-4 border-b bg-amber-50">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-500 mb-1">Invoice #</label>
                    <input
                      value={editInvoice.invoice_number}
                      onChange={e => setEditInvoice({ ...editInvoice, invoice_number: e.target.value })}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-500 mb-1">Client Name</label>
                    <input
                      value={editInvoice.client_name}
                      onChange={e => setEditInvoice({ ...editInvoice, client_name: e.target.value })}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-500 mb-1">Bill To (Legal Name)</label>
                    <input
                      value={editInvoice.client_legal_name}
                      onChange={e => setEditInvoice({ ...editInvoice, client_legal_name: e.target.value })}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-500 mb-1">Bill To (Address)</label>
                    <input
                      value={editInvoice.client_address}
                      onChange={e => setEditInvoice({ ...editInvoice, client_address: e.target.value })}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-500 mb-1">Payment Terms</label>
                    <div className="flex gap-2">
                      <input
                        value={editInvoice.payment_terms}
                        onChange={e => setEditInvoice({ ...editInvoice, payment_terms: e.target.value })}
                        className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm"
                        placeholder="Net 30"
                      />
                      <input
                        type="number"
                        value={editInvoice.payment_terms_days}
                        onChange={e => setEditInvoice({ ...editInvoice, payment_terms_days: Number(e.target.value) })}
                        className="w-20 border border-gray-300 rounded px-2 py-1.5 text-sm text-center"
                        title="Days"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-500 mb-1">Due Date</label>
                    <input
                      type="date"
                      value={editInvoice.due_date}
                      onChange={e => setEditInvoice({ ...editInvoice, due_date: e.target.value })}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-3">
                  <button
                    onClick={() => setEditInvoice(null)}
                    className="text-sm px-4 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={saveEdit}
                    disabled={saving}
                    className="text-sm bg-mcl-blue hover:bg-blue-800 text-white font-semibold px-4 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {saving ? 'Guardando...' : 'Guardar'}
                  </button>
                </div>
              </div>
            )}

            {/* Invoice preview */}
            <div className="p-6 overflow-auto max-h-[80vh]">
              <InvoicePrintView invoice={viewInvoice} ref={printRef} />
            </div>
          </div>
        </div>
      )}

      {/* Hidden print div for PDF (when downloading without modal) */}
      {viewInvoice && (
        <div style={{ position: 'fixed', left: '-9999px', top: 0 }}>
          <InvoicePrintView invoice={viewInvoice} ref={printRef} />
        </div>
      )}
    </Layout>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Invoice Print View — matches approved HTML mockup
// ══════════════════════════════════════════════════════════════════════════════

import { forwardRef } from 'react'

const InvoicePrintView = forwardRef<HTMLDivElement, { invoice: WSInvoice }>(({ invoice: inv }, ref) => {
  // Due date: prefer stored due_date, fallback = service date + terms
  const dueDate = (inv as any).due_date
    || (inv.completed_at ? addDays(inv.completed_at, inv.payment_terms_days || 30)
    : inv.received_at ? addDays(inv.received_at, inv.payment_terms_days || 30)
    : inv.issued_at ? addDays(inv.issued_at, inv.payment_terms_days || 30) : null)
  const hasDiscount = inv.discount > 0
  const isSpecialCargo = inv.cargo_type === 'SPECIAL'
  const hasInOutAbsorbed = isSpecialCargo && !inv.charges.some(c => c.service_type === 'in_out' && c.amount > 0)

  return (
    <div ref={ref} style={{
      width: '8.5in', background: '#fff',
      padding: '0.6in 0.7in', position: 'relative',
      fontFamily: "'Helvetica Neue', Arial, sans-serif", fontSize: '11px', color: '#374151',
    }}>
      {/* Watermark */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%) rotate(-35deg)',
        fontSize: '72px', fontWeight: 900, color: 'rgba(0,0,0,0.03)',
        letterSpacing: '10px', pointerEvents: 'none',
      }}>INVOICE</div>

      {/* Stamp */}
      {inv.status === 'paid' && (
        <div style={{
          position: 'absolute', top: '200px', right: '60px', transform: 'rotate(-15deg)',
          fontSize: '36px', fontWeight: 900, letterSpacing: '4px', padding: '6px 20px',
          borderRadius: '8px', opacity: 0.15, color: '#16a34a', border: '4px solid #16a34a',
        }}>PAID</div>
      )}
      {inv.status === 'void' && (
        <div style={{
          position: 'absolute', top: '200px', right: '60px', transform: 'rotate(-15deg)',
          fontSize: '36px', fontWeight: 900, letterSpacing: '4px', padding: '6px 20px',
          borderRadius: '8px', opacity: 0.15, color: '#dc2626', border: '4px solid #dc2626',
        }}>VOID</div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '3px solid #0f1d3a', paddingBottom: '14px', marginBottom: '18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{
            width: '56px', height: '56px', background: '#0f1d3a', borderRadius: '8px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 900, fontSize: '14px', letterSpacing: '1px',
          }}>MCL</div>
          <div>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#0f1d3a' }}>MinCurl Logistics LLC</div>
            <div style={{ fontSize: '10px', color: '#6b7280', marginTop: '2px' }}>2323 NW 82nd Ave, Doral, FL 33122</div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '26px', fontWeight: 900, color: '#dc2626', letterSpacing: '1px' }}>INVOICE</div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: '#0f1d3a', fontFamily: "'Courier New', monospace", marginTop: '2px' }}>{inv.invoice_number}</div>
        </div>
      </div>

      {/* Bill-to + Invoice details */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '16px' }}>
        <div style={{ flex: 1, background: '#f7f7f7', border: '1px solid #ddd', borderRadius: '6px', padding: '12px 16px', fontSize: '11px', lineHeight: 1.6 }}>
          <div style={{ fontSize: '9px', fontWeight: 800, color: '#dc2626', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Bill To</div>
          <strong>{inv.client_legal_name || inv.client_name}</strong><br />
          {inv.client_address && <>{inv.client_address}</>}
        </div>
        <div style={{ flex: 1 }}>
          <InfoGrid cells={[
            { label: 'Invoice #', value: inv.invoice_number, mono: true },
            { label: 'Date', value: fmtDate(inv.issued_at || inv.created_at) },
            { label: 'Due Date', value: dueDate ? fmtDate(dueDate) : '\u2014' },
            { label: 'Terms', value: inv.payment_terms || 'Net 30' },
            { label: 'Service Order', value: inv.so_number, mono: true, blue: true },
            { label: 'Currency', value: inv.currency || 'USD' },
          ]} />
        </div>
      </div>

      {/* SO Details */}
      <SectionTitle>Service Order Details</SectionTitle>
      <InfoGrid cells={[
        { label: 'AWB', value: inv.awb_number || '\u2014', mono: true },
        { label: 'Warehouse Receipt', value: inv.wr_number || '\u2014', mono: true, blue: true },
        { label: 'Cargo Type', value: `${CARGO_TYPE_LABELS[inv.cargo_type || ''] || inv.cargo_type || '\u2014'} \u2014 ${CARGO_MODE_LABELS[inv.cargo_mode || ''] || inv.cargo_mode || ''}` },
        { label: 'Reference', value: inv.reference || '\u2014' },
        { label: 'Received', value: fmtDate(inv.received_at) },
        { label: 'Completed', value: fmtDate(inv.completed_at) },
      ]} style={{ marginBottom: '16px' }} />

      {/* Charges table */}
      <SectionTitle>Charges</SectionTitle>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px', marginBottom: 0 }}>
        <thead>
          <tr>
            <ThCell>Service</ThCell>
            <ThCell>Detail</ThCell>
            <ThCell align="right" last>Amount</ThCell>
          </tr>
        </thead>
        <tbody>
          {inv.charges.filter(c => c.amount > 0).map((ch, i) => (
            <tr key={i}>
              <td style={{ padding: '7px 10px', borderBottom: '1px solid #e5e7eb', color: '#374151' }}>
                <strong>{SERVICE_LABELS[ch.service_type] || ch.service_type}</strong>
              </td>
              <td style={{ padding: '7px 10px', borderBottom: '1px solid #e5e7eb', color: '#374151', fontFamily: "'Courier New', monospace", fontSize: '10px' }}>
                {ch.detail || ch.description || '\u2014'}
              </td>
              <TdMono align="right"><strong>{fmtUSD(ch.amount)}</strong></TdMono>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 0 }}>
        <table style={{ borderCollapse: 'collapse', minWidth: '240px' }}>
          <tbody>
            <tr>
              <td style={{ padding: '5px 14px', textAlign: 'right', color: '#6b7280', fontWeight: 600, fontSize: '11px' }}>Subtotal</td>
              <td style={{ padding: '5px 14px', textAlign: 'right', fontWeight: 600, color: '#1f2937', fontFamily: "'Courier New', monospace", fontSize: '11px' }}>{fmtUSD(inv.subtotal)}</td>
            </tr>
            {hasDiscount && (
              <tr>
                <td style={{ padding: '5px 14px', textAlign: 'right', color: '#dc2626', fontWeight: 600, fontSize: '11px' }}>Discount</td>
                <td style={{ padding: '5px 14px', textAlign: 'right', color: '#dc2626', fontWeight: 600, fontFamily: "'Courier New', monospace", fontSize: '11px' }}>-{fmtUSD(inv.discount)}</td>
              </tr>
            )}
            <tr>
              <td style={{ padding: '5px 14px', textAlign: 'right', color: '#6b7280', fontWeight: 600, fontSize: '11px' }}>Tax</td>
              <td style={{ padding: '5px 14px', textAlign: 'right', fontWeight: 600, color: '#1f2937', fontFamily: "'Courier New', monospace", fontSize: '11px' }}>$0.00</td>
            </tr>
            <tr>
              <td style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 900, color: '#0f1d3a', fontSize: '14px', borderTop: '2px solid #0f1d3a' }}>TOTAL</td>
              <td style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 900, color: '#0f1d3a', fontFamily: "'Courier New', monospace", fontSize: '14px', borderTop: '2px solid #0f1d3a' }}>{fmtUSD(inv.total)} USD</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Note */}
      {hasInOutAbsorbed && (
        <div style={{ marginTop: '16px', padding: '10px 14px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '6px', fontSize: '10px', color: '#4b5563', lineHeight: 1.6 }}>
          <strong>NOTE:</strong> In/Out charges are included in the Screening Special Cargo rate.
        </div>
      )}

      {/* Bank details */}
      <div style={{ marginTop: '20px', fontSize: '9px', color: '#6b7280', lineHeight: 1.7, borderTop: '1px solid #e5e7eb', paddingTop: '10px' }}>
        <strong style={{ color: '#374151' }}>BANK DETAILS:</strong><br />
        BANK NAME: JP MORGAN CHASE<br />
        ROUTING NUMBER: 267084131<br />
        ACCOUNT NUMBER: 818777270<br />
        SWIFT: CHASUS33<br />
        Name: MinCurl Logistics LLC
      </div>

      <div style={{ textAlign: 'center', marginTop: '15px', fontSize: '9px', color: '#999' }}>ORIGINAL</div>

      {/* Footer */}
      <div style={{ textAlign: 'center', fontSize: '8px', color: '#9ca3af', borderTop: '1px solid #e5e7eb', paddingTop: '8px', marginTop: '20px' }}>
        MinCurl Logistics LLC &bull; 2323 NW 82nd Ave, Doral, FL 33122 &bull; admin@mincurllogistics.com<br />
        Thank you for your business.
      </div>
    </div>
  )
})

// ── Sub-components ──

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: '10px', fontWeight: 800, color: '#0f1d3a', textTransform: 'uppercase',
      letterSpacing: '1px', marginBottom: '8px', paddingBottom: '4px', borderBottom: '1.5px solid #e5e7eb',
    }}>{children}</div>
  )
}

function InfoGrid({ cells, style }: { cells: { label: string; value: string; mono?: boolean; blue?: boolean }[]; style?: React.CSSProperties }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 1fr', border: '1px solid #d1d5db',
      borderRadius: '6px', overflow: 'hidden', ...style,
    }}>
      {cells.map((c, i) => (
        <div key={i} style={{
          padding: '8px 12px',
          borderBottom: i < cells.length - 2 ? '1px solid #e5e7eb' : 'none',
          borderRight: i % 2 === 0 ? '1px solid #e5e7eb' : 'none',
        }}>
          <div style={{ fontSize: '8px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '2px' }}>{c.label}</div>
          <div style={{
            fontSize: '11px', fontWeight: 600,
            color: c.blue ? '#2563eb' : '#1f2937',
            fontFamily: c.mono ? "'Courier New', monospace" : 'inherit',
          }}>{c.value}</div>
        </div>
      ))}
    </div>
  )
}

function ThCell({ children, align, last }: { children: React.ReactNode; align?: string; last?: boolean }) {
  return (
    <th style={{
      background: '#0f1d3a', color: '#fff', padding: '7px 10px',
      textAlign: (align as any) || 'left', fontWeight: 700, fontSize: '9px',
      textTransform: 'uppercase', letterSpacing: '0.5px',
      borderRadius: last ? '0 4px 0 0' : undefined,
    }}>{children}</th>
  )
}

function TdMono({ children, align }: { children: React.ReactNode; align?: string }) {
  return (
    <td style={{
      padding: '7px 10px', borderBottom: '1px solid #e5e7eb', color: '#374151',
      textAlign: (align as any) || 'left', fontFamily: "'Courier New', monospace",
    }}>{children}</td>
  )
}
