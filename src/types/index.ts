export interface ClientShipper {
  name: string
  address?: string
  city?: string
  province?: string
  country?: string
  zip?: string
}

export interface ClientConsignee {
  name: string
  full_address?: string
  notify_to?: string
}

export interface ClientEmailRecipient {
  name: string
  email: string
  destination?: string
  notify_wr?: boolean
  notify_gate_out?: boolean
  notify_docs?: boolean
}

export interface Client {
  id?: string
  name: string
  shippers: ClientShipper[]
  consignees: ClientConsignee[]
  email_recipients: ClientEmailRecipient[]
  created_at?: string
}

export interface Consignee {
  id: string
  name: string
  full_address: string
  notify_to: string
}

export interface WRLine {
  id?: string
  wr_id?: string
  line_order: number
  packing_type: string
  has_lb: boolean
  is_dg: boolean
  qty: number
  length_cm: number | null
  width_cm: number | null
  height_cm: number | null
  cbm: number | null
  weight_kg: number | null
  location: string
  remarks: string
  photo_url?: string   // legacy — single photo
  photo_urls?: string[] // current — multiple photos
}

export interface SkuLine {
  id?: string
  sku: string
  vin: string
  received_qty: number
  case_pack: number
}

export interface WarehouseReceipt {
  id?: string
  wr_number?: string

  // Counter fields
  agent_code?: string
  company_name: string
  notify_to?: string
  po_number: string
  from_port: string
  to_port: string
  status: string

  driver_name: string
  driver_license: string
  driver_license_photo_url?: string

  declared_pieces: number | null
  declared_weight_kg: number | null
  observations: string

  // Physical reception fields
  consignee_id: string | null
  consignee?: Consignee

  // Computed totals
  total_qty: number
  total_cbm: number
  total_weight_kg: number

  // Cargo type
  cargo_type?: 'BOND' | 'LOC'

  // Workflow
  counter_status: string
  physical_status: string
  dispatch_status?: string
  container_number?: string
  dispatched_at?: string
  dispatch_booking_number?: string
  dispatch_seal_number?: string
  dispatch_driver_name?: string
  client_id?: string
  client_name?: string
  consignee_name?: string
  counter_by?: string
  physical_by?: string

  created_at?: string
  updated_at?: string

  // Accounting
  uploaded_to_client?: boolean

  // Warehouse Services source
  source?: 'warehouse_services'
  so_id?: string
  so_number?: string
  awb_number?: string

  // Relations
  wr_lines?: WRLine[]
}

export type AppUser = {
  id: string
  email: string
  name: string
}

export const PACKING_TYPES = [
  'SKID',
  'Box',
  'Bolsa',
  'DContainer',
  'Crate',
  'Oversize',
  'Otro',
] as const

export const DESTINATION_PORTS = [
  'LIM', 'BOG', 'ARG', 'SCL', 'MVD', 'GRU', 'EZE', 'UIO', 'CCS', 'PTY', 'GYE', 'ASU', 'SAL'
] as const

// Sea freight uses country codes (migrated from city/airport codes)
export const SEA_DESTINATIONS = [
  'ARG', 'COL', 'PER', 'CHL', 'MVD', 'GRU', 'UIO', 'CCS', 'PTY', 'GYE', 'ASU', 'SAL', 'Santos'
] as const

export const NAVIERAS = [
  'MSC', 'Maersk', 'Hapag-Lloyd', 'CMA CGM', 'Evergreen',
  'COSCO', 'ONE', 'Yang Ming', 'ZIM', 'Seaboard Marine', 'Otra',
] as const

export const CONTAINER_SIZES = ['20', '40', '40HC', '45', 'LCL'] as const

export interface Dispatch {
  id?: string
  booking_number: string
  booking_request_li?: string
  container_number: string
  container_size: string
  naviera: string
  naviera_other?: string
  transport_company: string
  scheduled_at: string
  wr_ids: string[]
  wr_numbers: string[]
  po_numbers: string[]
  consignees: string[]
  destinations: string[]
  total_qty: number
  total_cbm: number
  total_kg: number
  // Gate out
  seal_number?: string
  seal_photo_url?: string
  container_photo_url?: string
  gate_driver_name?: string
  gate_driver_license?: string
  gate_driver_photo_url?: string
  gate_out_at?: string
  // Status
  status: 'booked' | 'gate_out'
  client_names?: string[]
  client_ids?: string[]
  created_at?: string
  created_by?: string
  loading_type?: 'forklift' | 'by_hand' | null
  drayage?: boolean
  hazmat?: boolean
  // Container return events
  return_events?: ReturnEvent[]
  // Correction log (post gate-out edits)
  corrections?: CorrectionEntry[]
  // Partial PO allocations (when only some pieces of a WR go in this dispatch)
  line_allocations?: DispatchLineAllocation[]
  partial_wr_ids?: string[]
}

export interface DispatchLineAllocation {
  wr_id: string
  wr_line_id: string
  allocated_qty: number
  total_qty: number
  cbm: number
  weight_kg: number
  note?: string
}

export interface CorrectionEntry {
  corrected_at: string
  corrected_by: string
  changes: Record<string, { from: any; to: any }>
}

export interface ReturnEvent {
  returned_at: string
  returned_by: string
  reason?: string | null
  port_to_warehouse: number
  warehouse_to_port: number
  waiting_time: number | null
  weekend_fee: number | null
  total: number
}

export type UserRole = 'admin' | 'gerente' | 'accounting' | 'super_agent' | 'agent' | 'client' | 'counter' | 'bodega' | 'viewer' | 'vendor_admin' | 'distribuidor' | 'soporte_it' | 'av_viewer' | 'dispatcher'
export type ModuleAccess = 'seafreight' | 'airfreight' | 'warehouse_services' | 'avianca'

// ── Inventory Documents (Sea Freight) ────────────────────────────────────────

export type DocCheckState = null | 'check' | 'na'
export type SemaphoreColor = 'blue' | 'yellow' | 'gray'

export interface InvDocFile {
  id: string
  url: string
  storage_path: string
  filename: string
  uploaded_at: string
  uploaded_by: string
}

export interface InvDocComment {
  id: string
  text: string
  user_name: string
  user_id: string
  created_at: string
  deleted: boolean
  deleted_by?: string
  deleted_at?: string
}

export interface InventoryDocument {
  id?: string
  wr_id: string
  wr_number: string
  po_number: string
  vendor: string
  country: string
  cargo_type: string
  total_pieces: number
  total_cbm: number
  total_kg: number
  client_id: string | null
  client_name: string

  schedule: string
  schedule_locked: boolean
  br: string
  br_locked: boolean

  check_sli: DocCheckState
  check_pl: DocCheckState
  check_inv: DocCheckState
  check_co: DocCheckState
  check_mc: DocCheckState
  check_7512: DocCheckState
  check_dreb: DocCheckState

  files: InvDocFile[]
  comments: InvDocComment[]

  last_modified_by: string
  last_modified_at: string
  created_at: string
}

export function getDocSemaphore(doc: InventoryDocument | undefined): SemaphoreColor {
  if (!doc) return 'gray'
  const checks = [doc.check_sli, doc.check_pl, doc.check_inv, doc.check_co, doc.check_mc]
  // 7512 counts toward semaphore only for BONDED cargo
  if (doc.cargo_type === 'BOND') checks.push(doc.check_7512)
  const total = checks.length
  const done = checks.filter(c => c === 'check' || c === 'na').length
  if (done === total) return 'blue'
  if (done > 0) return 'yellow'
  return 'gray'
}

// ── Airfreight module ────────────────────────────────────────────────────────

export interface AirfreightDocumentFile {
  url: string
  filename: string
  version: number
  uploaded_at: string
  uploaded_by: string
  modified_seen: boolean
  history: { url: string; filename: string; version: number; uploaded_at: string; uploaded_by: string }[]
}

export interface AirfreightDocuments {
  doc_1f?: AirfreightDocumentFile
  doc_7512?: AirfreightDocumentFile
  doc_do_tsa?: AirfreightDocumentFile
  doc_mawb_draft?: AirfreightDocumentFile
  doc_mawb_def?: AirfreightDocumentFile
  doc_pickup_order?: AirfreightDocumentFile
  doc_lb_checklist?: AirfreightDocumentFile
  doc_ccsf?: AirfreightDocumentFile
}

export interface HoldItem {
  bag: string
  box: string
  photo?: AirfreightDocumentFile | null
}

export interface ScanItem {
  barcode: string
  weight: number
  pieces: number
  scanned_at: string
  scanned_by: string
}

export interface AwbSecondLeg {
  line_number?: string | null
  awb_number: string
  awb_2nd_leg?: string | null
  pieces: number
  slacs?: number | null
  weight: number
  chargeable_weight: number
  uld_type?: string | null
  uld_airline?: string | null
  loc_bond?: 'L' | 'B' | null
  label_color?: boolean
  pickup_from?: string | null
  ready_for_pickup?: string | null
  last_day_free?: string | null
  battery?: boolean
  ddgg?: boolean
  hold?: boolean | 'pending'
  split?: boolean
  split_from?: string        // awb_number de la línea original
  // Reference-only line (e.g. Merflex): multiple tracking numbers instead of a real 1ST LEG AWB
  is_ref_line?: boolean
  tracking_refs?: string[]
  scans?: ScanItem[]
  on_hand?: boolean
  // Export-specific fields
  destination?: string           // per-line destination for export bookings
  volume_weight?: number         // VW for export
  cargo_sub_type?: 'bonded' | 'local' | 'bonded_local'  // export cargo type
  holds?: HoldItem[]
  transport_company?: string
  transport_status?: 'pending' | 'picked_up' | 'on_hand'
  transport_docs?: AirfreightDocumentFile[]
  drop_off_time?: string | null
  documents?: {
    doc_1f?: AirfreightDocumentFile
    doc_7512?: AirfreightDocumentFile
    doc_pickup_order?: AirfreightDocumentFile
    doc_hawb?: AirfreightDocumentFile
    doc_lb_checklist?: AirfreightDocumentFile
  }
  // AWB LOG documents (manual upload)
  doc_acceptance?: AirfreightDocumentFile
  doc_whr?: AirfreightDocumentFile
  doc_mcl_transfer?: AirfreightDocumentFile
  // AWB LOG documents (MCL Transfer multi-file)
  doc_mcl_transfer_files?: AirfreightDocumentFile[]
  // AWB LOG documents (auto - Gmail agent)
  doc_screening_cert?: AirfreightDocumentFile
  screening_details?: {
    mawb: string
    awb: string
    date: string
    time: string
    phantom_screener: string
    mcl_representant: string
    uld: string
    pieces: number
  }
  // Screening agent accumulation
  screening_status?: 'pending' | 'partial' | 'complete' | 'error'
  screening_pieces_screened?: number
  // Dispatched status (per-AWB, ecommerce flow). Marked when the AWB is physically
  // handed to the airline. When all AWBs of a flight are dispatched the flight
  // transitions to flight_status='dispatched'. A dispatched AWB is locked — only
  // MCL can reopen it.
  dispatched?: boolean
  dispatched_at?: string | null
  dispatched_by?: string | null
  // Ecommerce bulk-upload docs (BookingList single-block upload). The client
  // (or MCL) drops any number of files into a generic bucket (doc_uploads)
  // and then ticks which doc types that batch covers. The checks — not the
  // files themselves — drive the AWB Log semáforos.
  doc_uploads?: AirfreightDocumentFile[]
  doc_checks?: {
    awb?: boolean
    doc_7512?: boolean
    do_tsa?: boolean
  }
  doc_checks_by?: string
  doc_checks_at?: string
  // Forward-written audit log (granular events going forward)
  audit_log?: AuditLogEntry[]
  // Cargo Tracking Agent fields
  tracking_status?: string | null          // IATA milestone: BKD, DEP, ARR, RCF, NFD, DLV
  tracking_inbound_flight?: string | null  // Real inbound flight number (e.g. TK72, 5Y8977)
  tracking_eta?: string | null             // ETA or actual arrival at MIA (ISO datetime)
  tracking_origin?: string | null          // Origin station (IST, CGO, HKG...)
  tracking_pieces?: number | null
  tracking_weight?: number | null
  tracking_uld?: string | null
  tracking_last_checked?: string | null    // ISO timestamp of last check
  tracking_legs?: TrackingLeg[] | null     // All milestones
}

export interface TrackingLeg {
  station: string
  status: string       // IATA code: BKD, RCS, DEP, ARR, RCF, NFD, DLV
  label: string        // Human-readable: "Departed", "Arrived", etc.
  time: string         // ISO datetime or raw string
  flight?: string
  pieces?: number
  weight?: number
  uld?: string
}

export interface AuditLogEntry {
  action: string        // e.g. 'created', 'doc_uploaded', 'dispatched', 'hold_set', 'field_changed', etc.
  detail?: string       // human-readable description
  user: string          // email or uid
  at: string            // ISO timestamp
  field?: string        // which field changed (optional)
  old_value?: string    // previous value (optional)
  new_value?: string    // new value (optional)
}

export interface AwbLine {
  id?: string
  booking_id?: string
  flight_id: string
  line_number: string
  awb_1st_leg: string
  awb_2nd_legs: AwbSecondLeg[]
  uld_type: string
  pieces: number
  slacs?: number
  weight: number
  chargeable_weight: number
  lithium_battery: boolean
  ddgg: boolean
  notes?: string
  was_reassigned?: boolean
  move_log?: {
    moved_at: string
    moved_by: string
    from_flight_id: string
    from_flight_label: string
    to_flight_id: string
    to_flight_label: string
  }[]
  documents?: {
    doc_1f?: AirfreightDocumentFile
    doc_7512?: AirfreightDocumentFile
    doc_pickup_order?: AirfreightDocumentFile
  }
}

export interface ChangeLogEntry {
  changed_at: string
  changed_by: string
  change_type: 'created' | 'booking_update' | 'flight_reassignment'
  fields_changed: { field: string; label: string; old_value: string; new_value: string }[]
}

export interface AirfreightBooking {
  id?: string
  flight_id: string
  flight_number?: string
  booking_type: 'simple' | 'mawb' | 'ecommerce' | 'export'
  client_id: string
  client_name: string
  agent_name?: string
  status: 'submitted' | 'onhand' | 'dropped' | 'completed'
  created_by: string
  created_at: string
  change_count: number
  modified_seen: boolean
  change_log: ChangeLogEntry[]

  // Campos comunes
  airline: string
  destination_id: string
  destination_custom?: string

  // Solo 'simple'
  awb_1st_leg?: string
  awb_2nd_leg?: string
  uld_type?: string
  pieces?: number
  weight?: number
  chargeable_weight?: number
  slacs?: number | null
  pickup_from?: string
  ready_for_pickup?: string
  last_day_free?: string
  deliver_to?: string
  hold_bg?: string
  hold_box?: string
  battery?: boolean
  ddgg?: boolean
  hold?: boolean | 'pending'
  on_hand?: boolean
  holds?: HoldItem[]

  // Solo 'mawb'
  mawb_number?: string
  awb_lines?: AwbSecondLeg[]

  // Import docs (Transportation module)
  import_1f_files?: AirfreightDocumentFile[]
  import_release_files?: AirfreightDocumentFile[]
  import_payment_files?: AirfreightDocumentFile[]

  // Documentos nivel booking / MAWB
  documents?: AirfreightDocuments

  // Screening agent
  screening_status?: 'pending' | 'partial' | 'complete' | 'error'
  screening_pieces_total?: number
  screening_events?: string[]

  // Hitos MCL
  onhand_date?: string
  segregation?: boolean
  dropped_off_datetime?: string
  flight_actual?: string
  comments_mcl?: string
}

export interface AirfreightFlight {
  id?: string
  airline: string
  flight_datetime: string
  flight_number?: string
  destinations: string[]
  cutoff_datetime?: string
  status: 'open' | 'closed'
  created_by: string
  created_at: string
  doc_distribucion?: AirfreightDocumentFile
  doc_do_tsa?: AirfreightDocumentFile
  doc_manifesto?: AirfreightDocumentFile
  // Ecommerce Import AWBs — multi-file upload at flight level (MCL).
  // Drives the "Imp AWB" semáforo in AWB Log for ecommerce lines.
  doc_import_awb?: AirfreightDocumentFile
  doc_import_awb_files?: AirfreightDocumentFile[]
  doc_do_tsa_files?: AirfreightDocumentFile[]
  doc_manifesto_files?: AirfreightDocumentFile[]
  doc_distribucion_files?: AirfreightDocumentFile[]
  flight_status?: 'booked' | 'in_progress' | 'terminado' | 'built' | 'dispatched'
  dispatched_at?: string
  was_modified?: boolean      // some bookings were moved away from this flight
  from_modification?: boolean // this flight was created via "Modificar vuelo"
  booking_updated?: boolean   // client modified/deleted AWBs in the booking
}

export interface AirHandlingOverride {
  airline: string
  rate: number
}

export interface AirfreightClientBilling {
  // Legal / invoice info
  company_legal_name?: string
  billing_address?: string
  account_number?: string
  tax_id?: string
  payment_terms_days?: number
  payment_terms_label?: string
  billing_contacts?: { name: string; email: string }[]
  charge_visibility_enabled?: boolean

  // Auto charges master switch
  auto_charges_enabled?: boolean

  // ALL-IN (one line on invoice) — only when deliver_to = airline
  // Composed of: Handling BUP + Screening + Drop Off BUP
  // If all_in_flat_rate is set → use this single rate instead (e.g. Merflex $0.17)
  all_in_flat_rate?: number | null
  handling_bup_rate?: number       // $0.104
  screening_rate?: number          // $0.07
  drop_off_bup_rate?: number       // $0.016
  handling_bup_overrides?: AirHandlingOverride[]  // e.g. AVIANCA → $0.114

  // Additional auto charges (independently toggled)
  handling_loose_enabled?: boolean
  handling_loose_rate?: number     // $0.04/kg, deliver to address
  drop_off_loose_enabled?: boolean
  drop_off_loose_rate?: number     // $0.03/kg, deliver to address
  pickup_loose_enabled?: boolean
  pickup_loose_rate?: number       // $0.03/kg, LOOSE + deliver to airline
  bup_pickup_enabled?: boolean
  bup_pickup_rate?: number         // $50 flat, BUP cargo
  breakdown_enabled?: boolean
  breakdown_rate?: number          // $0.06/kg, BUP cargo
  wooden_pallets_enabled?: boolean
  wooden_pallet_rate?: number      // $5, LOOSE, ROUND(PCs/16,0) × rate
  buildup_wp_enabled?: boolean
  buildup_wp_rate?: number         // $5, ROUND(CW/divisor × multiplier) × rate
  buildup_wp_divisor?: number      // default 1500
  buildup_wp_multiplier?: number   // default 4
  buildup_wp_airlines?: string[]   // ['AVIANCA']

  // Weight source override: 'chw' (default) uses chargeable_weight, 'gross' uses gross weight
  billing_weight_source?: 'chw' | 'gross'
}

export interface AirfreightClient {
  id?: string
  name: string
  booking_type: 'simple' | 'mawb' | 'ecommerce' | 'export'
  transportation_enabled?: boolean
  contacts: { name: string; email: string; phone?: string }[]
  notify_emails: string[]
  active: boolean
  created_at?: string
  billing?: AirfreightClientBilling
  // CCSSSP (client's own security program document)
  ccsssp_company_name?: string   // header: e.g. "EXPRESS LINE CORPORATION"
  ccsssp_short_name?: string     // in-text: e.g. "EXPRESS LINE CORP." (defaults to company_name)
  ccsssp_tsa_number?: string     // e.g. "WP9403041" or "SE0704011"
  ccsssp_address?: string        // e.g. "901 W. Arbor Vitae St. Inglewood, CA 90301"
  ccsssp_phone?: string
  ccsssp_email?: string
  ccsssp_logo_url?: string       // Firebase Storage URL for client logo (left)
  ccsssp_logo_right_url?: string // Firebase Storage URL for right-side logo (e.g. C-TPAT)
  ccsssp_format?: string         // per-client template: 'express_line' | 'merflex'
  ccsssp_rep_name?: string       // fixed representative name (e.g. "Carlos Villegas")
  ccsssp_signature_url?: string  // Firebase Storage URL for representative signature image
  requires_agent?: boolean       // When true, doc receptions require an "agent_name" field (e.g. Avianca)
}

export interface AirfreightDestination {
  id?: string
  code: string
  name: string
  active: boolean
  sort_order: number
}

export interface RateSchedule {
  id?: string
  name: string
  billing_event: 'reception' | 'dispatch' | 'optional'
  unit: 'per_cbm' | 'per_pallet' | 'per_kg' | 'flat' | 'per_day_pallet' | 'per_container' | 'per_bl' | 'per_report' | 'per_wr' | 'per_lbs' | 'per_label'
  price: number
  currency: string
  cargo_type: 'LOC' | 'BOND' | 'BOTH'
  container_size?: '20' | '40' | null
  loading_type?: 'forklift' | 'by_hand' | null
  active: boolean
  remarks?: string
  sort_order?: number
}

// ── Billing Profiles ─────────────────────────────────────────────────────────

export interface BillingProfileContact {
  name: string
  role: string
  phone: string
  email: string
  active?: boolean
}

export interface EmailSettingsCC {
  name: string
  email: string
}

export interface BillingProfile {
  id?: string
  client_id: string
  client_name: string
  customer_name: string
  destinations: string[]
  notify_to: string
  payment_terms_days: number
  payment_terms_from: 'service' | 'invoice'
  contacts: BillingProfileContact[]
  observations: string
  active: boolean
  created_at?: string
}

// ── Airfreight Rate Schedule ──────────────────────────────────────────────────

export type AirRateCategory = 'handling' | 'screening' | 'dangerous_goods' | 'value_added' | 'transportation' | 'storage'

export type AirRateUnit = 'per_kg' | 'per_awb' | 'per_box' | 'per_pallet' | 'per_uld' | 'per_hour' | 'per_oversize_unit' | 'flat'

export interface AirRateSchedule {
  id?: string
  name: string
  category: AirRateCategory
  unit: AirRateUnit
  price: number
  currency: string
  minimum_charge: number | null
  free_period_days: number | null
  included_qty: number | null
  overage_price: number | null
  active: boolean
  sort_order: number
  remarks?: string
  client_overrides?: Record<string, number>  // client_id → override price
}

export interface AirRateAirlineOverride {
  id?: string
  airline: string
  rate_id: string
  rate_name: string
  price: number | null
  minimum_charge: number | null
  active: boolean
}

// ── Airfreight Holds ────────────────────────────────────────────────────────

export type HoldStatus = 'informed' | 'photo_taken' | 'cbp_released' | 'pending_instruction' | 'fly' | 'send_do' | 'completed'

export interface AirfreightHold {
  id?: string
  // Origen
  booking_id: string
  flight_id: string
  flight_number: string
  flight_date: string
  client_id: string
  client_name: string
  awb_number: string
  // Identificación del paquete
  bag: string
  box: string
  // Estado
  status: HoldStatus
  // Foto del hold (MCL sube)
  hold_photo?: AirfreightDocumentFile | null
  // CBP
  cbp_released_at?: string
  cbp_released_by?: string
  cbp_notes?: string
  // Instrucción del cliente
  instruction?: 'fly' | 'send_do'
  instruction_at?: string
  instruction_by?: string
  // Si instruction = 'fly'
  fly_flight_id?: string
  fly_flight_number?: string
  fly_mawb?: string
  // Documentos del cliente (uno o varios)
  client_documents?: AirfreightDocumentFile[]
  // Metadata
  created_at: string
  updated_at?: string
}

export interface AirRateClientOverride {
  id?: string
  client_id: string
  client_name: string
  airline: string | null
  rate_id: string | null
  rate_name: string
  category: AirRateCategory
  unit: AirRateUnit
  price: number
  minimum_charge: number | null
  active: boolean
  is_custom: boolean
  remarks?: string
}

// ── Screening Agent ─────────────────────────────────────────────────────────

export interface ScreeningEvent {
  id?: string
  gmail_message_id: string
  gmail_subject: string
  gmail_date: string
  pdf_url: string
  pdf_storage_path?: string
  pdf_filename: string
  extracted: {
    mawb: string
    awb: string
    date: string
    time: string
    phantom_screener: string
    mcl_representant: string
    uld: string
    pieces: number
    uld_lines?: { awb: string; uld_type: string; uld_number: string; pieces: number }[]
  }
  matched_booking_id: string | null
  matched_flight_id: string | null
  match_method: 'mawb' | 'awb_2nd_leg' | 'unmatched' | 'manual_correction'
  matched_via?: string
  matched_line_awb?: string
  match_status: 'matched' | 'unmatched' | 'error' | 'duplicate'
  error_reason?: string
  processed_at: string
  status: 'processed' | 'error' | 'unmatched' | 'duplicate'
}

export interface ScreeningSettings {
  phantom_k9_emails: string[]
  mcl_alert_emails: string[]
  enabled: boolean
  last_run?: string
  last_run_status?: string
  last_run_count?: number
}

export interface EscalationEntry {
  flight_id: string
  booking_id: string
  mawb_or_awb: string
  first_alert_date: string
  last_alert_date: string
  alert_count: number
  status: 'open' | 'resolved'
}

// ── Delivery Orders ─────────────────────────────────────────────────────────

export interface AwbEntry {
  booking_id: string
  booking_type: 'ecommerce' | 'mawb' | 'export'
  awb_index: number
  awb_number: string        // 2nd leg
  awb_1st_leg: string
  client_name: string
  client_id: string
  agent_name?: string
  flight_number: string
  flight_id: string
  airline: string
  destination: string
  deliver_to: string        // airline name
  pieces: number            // internal, for sets/CCSF
  weight: number            // internal, for sets/CCSF
  has_battery: boolean
  selected_hawb_indices?: number[]  // MAWB only: which child AWBs go in this DO
  frozen_pc?: 'C' | 'P' | null      // P/C status frozen at DO save time
}

export interface DeliveryOrder {
  id?: string
  do_number: string                    // "DO-0000001"
  date: string                         // ISO timestamp
  status: 'draft' | 'complete'
  created_at: string
  created_by: string
  updated_at?: string

  // Multi-AWB entries
  awb_entries: AwbEntry[]
  awb_keys: string[]                   // ["bookingId::awbIndex", ...] for Firestore array-contains

  // Shared transport data
  trucking_company: string             // "CO-Transportation" | "GEO Transport" | custom
  driver_name: string
  custody_method: 'seal' | 'escort' | 'locked_vehicle'
  seal_number: string                  // if custody_method = 'seal'
  escort_name: string                  // if custody_method = 'escort'
  ulds_loaded: string[]               // up to 10 items
  mcl_agent: string
  ccsf_screening_type: 'originated' | 'on_behalf'  // default: 'originated'
  accepted_for: 'CAO' | 'PAX'         // for LB Checklist

  // Origin (bodega = created from mobile ULD scan)
  origin?: 'bodega'

  // Driver tracking
  driver_pin?: string
  driver_queue_id?: string | null
  tracking_id?: string | null

  // Legacy fields (backward compat — old DOs have these instead of awb_entries)
  booking_id?: string
  awb_index?: number
  awb_number?: string
  awb_1st_leg?: string
  airline?: string
  flight_number?: string
  flight_id?: string
  destination?: string
  pieces?: number
  weight?: number
  client_name?: string
  deliver_to?: string
  has_battery?: boolean
}

// ── Pick Up Orders ──────────────────────────────────────────────────────────

export interface PickupOrderLine {
  client: string
  client_document: string        // Client ID / tax number / passport
  awb: string
  pmc: string                    // PMC #
  pieces: number
  weight: number                 // kg
  airline: string
  picked_up_by: string           // who picks up
  delivered_by: string           // who delivers
  work_order: string             // work order # linked to driver
}

export interface PickupOrder {
  id?: string
  pu_number: string              // "PU-0000001"
  date: string                   // ISO timestamp
  status: 'draft' | 'complete'
  created_at: string
  created_by: string
  updated_at?: string

  lines: PickupOrderLine[]

  // Transport
  trucking_company: string
  driver_name: string
  mcl_agent: string
  notes: string

  // Pickup details
  pickup_location: string
  drop_off_location?: string
  pickup_datetime: string        // ISO

  // Authorization Letter (uploaded by client)
  auth_letter_url?: string
  auth_letter_name?: string

  // Driver tracking
  driver_pin?: string
  driver_queue_id?: string | null
  tracking_id?: string | null
}

export interface PickupTracking {
  id?: string
  pu_id: string
  pu_number: string
  driver_pin: string
  driver_name: string
  vendor_id: string | null
  vendor_name: string
  driver_plate: string | null
  driver_queue_id: string | null
  milestones: {
    arrival_pickup?: MilestoneData
    loaded?: MilestoneData
    arrival_delivery?: MilestoneData
  }
  corrections: TrackingCorrection[]
  driver_notes?: { comment: string; photo_urls: string[]; updated_at: string }
  status: 'pending' | 'in_progress' | 'completed'
  created_at: string
}

// ── Air Billing ─────────────────────────────────────────────────────────────

export type AirCargoType = 'BUP' | 'LOOSE'
export type AirChargeStatus = 'pending' | 'invoiced' | 'voided'
export type AirInvoiceStatus = 'draft' | 'generated' | 'sent' | 'paid' | 'voided'


export interface AirBillingCharge {
  id?: string
  booking_id: string
  flight_id: string
  awb_index: number | null
  billing_unit_id: string

  awb_1st_leg: string | null
  awb_2nd_leg: string | null
  mawb_number: string | null
  booking_type: 'simple' | 'mawb' | 'ecommerce' | 'export'
  cargo_type: AirCargoType

  pieces: number
  weight: number
  chargeable_weight: number

  charge_name: string
  description: string
  unit: string
  qty: number
  rate: number
  total: number
  currency: string
  minimum_charge_applied: boolean

  client_id: string
  client_name: string
  airline: string
  flight_number: string

  scope: 'awb' | 'flight'
  source: 'auto' | 'manual'
  added_by: string
  rate_id: string | null

  invoice_id: string | null
  status: AirChargeStatus

  dispatched_at: string | null
  created_at: string
  created_by: string
}

export interface BillingReviewDetail {
  type: 'cw_changed' | 'pieces_changed' | 'new_manual_charge' | 'charge_deleted' | 'charges_recalculated'
  awb_number?: string
  billing_unit_id?: string
  old_value?: number
  new_value?: number
  charge_name?: string
  description: string
}

// ── Trucking Vendors & Driver Tracking ───────────────────────────────────────

export interface TruckingVendor {
  id?: string
  name: string
  status: 'active' | 'inactive'
  created_at: string
}

export interface VendorUser {
  id?: string
  uid: string
  email: string
  name: string
  vendor_id: string
  role: 'vendor_admin'
  created_at: string
}

export interface DriverQueueEntry {
  id?: string
  driver_name: string
  vendor_id: string | null
  vendor_name: string
  plate: string | null
  gps: { lat: number; lng: number }
  created_at: string
  expires_at: string
  linked_do_id: string | null
  status: 'waiting' | 'linked' | 'expired'
}

export interface MilestoneData {
  timestamp: string
  gps: { lat: number; lng: number }
}

export interface TrackingCorrection {
  milestone: string
  old_timestamp: string
  new_timestamp: string
  reason: string
  requested_by: string
  requested_at: string
  approved_by: string | null
  approved_at: string | null
  status: 'pending' | 'approved' | 'rejected'
}

export interface DeliveryTracking {
  id?: string
  do_id: string
  do_number: string
  driver_pin: string
  driver_name: string
  vendor_id: string | null
  vendor_name: string
  driver_plate: string | null
  driver_queue_id: string | null
  airline: string
  milestones: {
    arrival_mcl?: MilestoneData
    truck_loaded?: MilestoneData & { seal_photo_url?: string }
    arrival_airline?: MilestoneData
    gate_assigned?: MilestoneData
    unload_start?: MilestoneData
    unload_end?: MilestoneData
  }
  corrections: TrackingCorrection[]
  driver_notes?: { comment: string; photo_urls: string[]; updated_at: string }
  status: 'pending' | 'in_progress' | 'completed'
  created_at: string
}

export interface AirInvoice {
  id?: string
  invoice_number: string
  client_id: string
  client_name: string
  flight_id: string
  flight_number: string
  airline: string

  bill_to_name: string
  bill_to_address: string
  account_number: string
  reference: string

  charge_ids: string[]
  line_count: number

  subtotal: number
  tax: number
  adjustment_kind: 'discount' | 'surcharge' | null
  adjustment_calc: 'percent' | 'amount' | null
  adjustment_value: number
  adjustment_amount: number
  adjustment_note: string
  total: number
  currency: string

  date: string
  due_date: string
  payment_terms_label: string

  status: AirInvoiceStatus
  pdf_url: string | null
  sent_at: string | null
  paid_at: string | null

  billing_review_needed?: boolean
  billing_review_details?: BillingReviewDetail[]
  billing_review_dismissed_by?: string
  billing_review_dismissed_at?: string

  note?: string | null

  created_at: string
  created_by: string
}

// ── Warehouse Services ───────────────────────────────────────────────────────

export type WSServiceType =
  | 'screening_k9'
  | 'screening_xray'
  | 'screening_manual'
  | 'transport'
  | 'storage'
  | 'in_out'
  | 'repack'
  | 'dg_inspection'
  | 'handling_storage_fee'
  | 'breakdown_bup'

export type WSServiceItemStatus =
  | 'pending'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'fail'

export type WSGlobalStatus =
  | 'requested'
  | 'checked_in'
  | 'received'
  | 'in_progress'
  | 'completed'
  | 'billed'

export interface WSServiceItem {
  id: string
  type: WSServiceType
  status: WSServiceItemStatus
  started_at: string | null
  completed_at: string | null
  completed_by: string | null
  notes: string
  // storage
  location: string | null
  // transport
  pickup_from: string | null
  deliver_to: string | null
  scheduled_at: string | null
  do_id: string | null
  // screening
  method: 'k9' | 'xray' | 'manual' | null
  inspection_log_id: string | null
  cert_url: string | null
  report_pdf_url: string | null
}

export type WSCargoType = 'GENERAL' | 'DG' | 'PERISHABLE' | 'OVERSIZE' | 'SPECIAL' | 'OTHER'
export type WSCargoMode = 'LOC' | 'BOND'

export interface WSDocFile {
  id: string
  key: string            // doc_pl, doc_inv, etc.
  url: string
  storage_path: string
  filename: string
  uploaded_at: string
  uploaded_by: string
}

export interface WSBreakdownAwb {
  awb_number: string
  pieces: number
  weight_kg: number
  received_pieces?: number | null
  received_weight_kg?: number | null
  confirmed?: boolean
}

export interface WSServiceOrder {
  id?: string
  so_number: string
  client_id: string
  client_name: string
  awb_number: string | null
  reference: string | null
  service_items: WSServiceItem[]
  global_status: WSGlobalStatus
  // declared cargo
  declared_pieces: number
  declared_weight: number
  cargo_description: string
  cargo_type: WSCargoType
  cargo_mode: WSCargoMode
  // cross-references
  wr_id: string | null
  do_ids: string[]
  // Transport-only fields
  transport_only?: boolean
  fee_only?: boolean
  transport_type?: WSTransportType
  bup_count?: number | null
  cargo_lines?: WSCargoLine[]
  // Breakdown BUP fields
  breakdown_awbs?: WSBreakdownAwb[]
  // documents
  documents?: WSDocFile[]
  // counter / check-in
  driver_name: string | null
  driver_license: string | null
  driver_photo_url: string | null
  counter_agent: string | null
  checked_in_at: string | null
  received_at: string | null
  completed_at: string | null
  billed_at: string | null
  // POD (Proof of Delivery)
  pod_receiver?: string
  pod_receiver_id?: string
  pod_signature_url?: string
  pod_photo_url?: string
  pod_notes?: string
  pod_at?: string
  pod_by?: string
  // notes / comments
  notes?: string
  // soft delete
  deleted_at?: string | null
  deleted_by?: string | null
  created_by: string
  created_at: string
}

export interface WSInspectionLog {
  id?: string
  so_id: string
  so_number: string
  service_item_id: string
  awb_number: string | null
  method: 'xray' | 'manual' | 'dg_inspection'
  pieces_inspected: number
  pieces_total: number
  result: 'PASS' | 'FAIL'
  inspector_name: string
  inspector_email: string
  ccsf_number: string
  inspection_date: string
  notes: string
  photo_urls: string[]
  doc_urls: string[]
  created_at: string
  created_by: string
}

export interface WSRateSchedule {
  id?: string
  name: string
  billing_event: 'auto' | 'optional'
  service_type: WSServiceType | 'bonded_fee' | 'dg_documentary' | 'labeling' | 'wrapping' | 'order_preparation'
  cargo_mode: 'LOC' | 'BOND' | 'ALL'
  unit: 'per_pallet' | 'per_cbm' | 'per_kg' | 'per_piece' | 'per_awb' | 'per_wr' | 'per_uld' | 'per_label' | 'per_day_pallet' | 'flat'
  price: number
  currency: string
  minimum_charge: number | null
  free_days: number | null
  overage_price: number | null
  cycle_days: number | null
  compare_unit: string | null
  compare_price: number | null
  compare_logic: 'max' | 'sum' | null
  extra_stop_surcharge: number | null
  active: boolean
  sort_order: number
  remarks: string
}

export interface WSClientRateOverride {
  id?: string
  client_id: string
  client_name: string
  rate_id: string
  rate_name: string
  price: number | null
  minimum_charge: number | null
  active: boolean
  created_at: string
  updated_at: string
}

export interface WSBillingCharge {
  id?: string
  so_id: string
  so_number: string
  client_id: string
  client_name: string
  service_type: string
  description: string
  amount: number
  currency: string
  status: 'pending' | 'invoiced' | 'paid'
  created_at: string
  created_by: string
  rate_id?: string | null
  do_id?: string | null
  do_number?: string | null
  wr_id?: string | null
  invoice_id?: string | null
  storage_days?: number | null
}

// ── WS Transport-Only: Cargo Lines ──────────────────────────────────────────

export interface WSCargoLine {
  id: string
  awb: string
  reference: string
  pieces: number
  weight_kg: number
  note: string
}

export type WSTransportType = 'bup' | 'loose'

// ── WS Delivery Tracking (driver milestones for WS Transport) ──────────────

export type WSTransportMilestoneKey =
  | 'accepted'
  | 'at_pickup'
  | 'loaded'
  | `stop_${number}`
  | 'delivered'

export interface WSTransportMilestone {
  timestamp: string
  gps: { lat: number; lng: number }
  photo_urls?: string[]
}

export interface WSDeliveryTracking {
  id?: string
  do_id: string
  do_number: string
  so_id: string
  so_number: string
  driver_pin: string
  driver_name: string
  vendor_id: string | null
  vendor_name: string
  driver_plate: string | null
  driver_queue_id: string | null
  // Route
  pickup_from: string
  deliver_to: string
  extra_stops: string[]
  // Cargo
  transport_type: WSTransportType
  bup_count: number | null
  uld_numbers: string[]
  total_pieces: number
  total_weight: number
  // Client
  client_id: string
  client_name: string
  // Milestones (dynamic keys)
  milestones: Record<string, WSTransportMilestone>
  // Delivery
  receiver_name: string | null
  receiver_id: string | null
  delivery_notes: string | null
  delivery_photo_urls: string[]
  // Status
  status: 'pending' | 'in_progress' | 'completed'
  created_at: string
}

// ── WS Delivery Order (WS Transport) ───────────────────────────────────────

export interface WSDeliveryOrder {
  id?: string
  do_number: string
  so_id: string
  so_number: string
  client_id: string
  client_name: string
  // Route
  pickup_from: string
  deliver_to: string
  extra_stops: string[]
  // Transport
  transport_type: WSTransportType
  bup_count: number | null
  uld_numbers: string[]
  total_pieces: number
  total_weight: number
  // Driver
  trucking_company: string
  driver_name: string
  driver_id: string | null
  custody_method: string | null
  seal_number: string | null
  mcl_agent: string
  // PIN & tracking
  driver_pin: string
  tracking_id: string | null
  // Status
  status: 'active' | 'in_transit' | 'delivered' | 'cancelled'
  delivered_at: string | null
  // Metadata
  created_at: string
  created_by: string
}

export interface WSClient {
  id?: string
  name: string
  company_legal_name: string
  contact_name: string
  contact_email: string
  contact_phone: string
  address: string
  tax_id: string | null
  type: 'spot' | 'recurring'
  email_recipients: { name: string; email: string; notify_so?: boolean; notify_pod?: boolean }[]
  billing_address: string
  payment_terms_days: number
  payment_terms_label: string
  active: boolean
  notes: string
  created_at: string
}

// ── Avianca Cargo Module ───────────────────────────────────────────────────

export interface AvFlight {
  id?: string
  flight_number: string
  etd: string
  destination: string
  origin?: string
  status: 'booked' | 'in_progress' | 'completed' | 'dispatched'
  total_awbs: number
  total_pieces: number
  total_gross_kg: number
  total_chw_kg: number
  has_dg: boolean
  has_lb: boolean
  screening_complete: boolean
  created_at: string
  created_by: string
  updated_at?: string
}

export interface ManifestDgFlag {
  keyword: string
  context: string
  severity: 'warning' | 'critical'
  reviewed: boolean
  reviewed_by?: string
  reviewed_at?: string
}

export interface AvFlightAwb {
  id?: string
  flight_id: string
  awb_number: string
  iac: string
  pieces: number
  gross_weight_kg: number
  chw_kg: number
  dg: boolean
  dg_codes?: string[]
  lb: boolean
  lb_detail?: string
  total_pcs_in_pallets: number
  screened_pcs: number
  screening_status: 'pending' | 'partial' | 'complete'
  doc_awb_url?: string
  doc_awb_filename?: string
  doc_dg_url?: string
  doc_dg_filename?: string
  manifest_status?: 'none' | 'na' | 'clear' | 'flagged' | 'resolved'
  // AI-extracted fields
  shipper_name?: string
  consignee_name?: string
  shipper_phone?: string
  agent_name?: string
  iac_name?: string
  nature_of_goods?: string
  ai_status?: 'pending' | 'processing' | 'complete' | 'failed' | 'needs_review'
  ai_error?: string
  ai_processed_at?: string
  // Soft-delete fields
  status?: 'active' | 'removed'
  removal_reason?: 'hold' | 'flight_change' | 'client_cancel' | 'other'
  removal_reason_detail?: string
  removed_at?: string
  removed_by?: string
  billable?: boolean
  created_at: string
  updated_at?: string
}

export interface AvManifestCheck {
  id?: string
  flight_id: string
  awb_id: string
  awb_number: string
  doc_url: string
  doc_filename: string
  status: 'pending' | 'processing' | 'clear' | 'flagged' | 'resolved'
  flagged_keywords?: { term: string; category: string; severity: 'warning' | 'critical'; context: string }[]
  ai_summary?: string
  resolved_by?: string
  resolved_at?: string
  resolved_note?: string
  ai_status?: 'pending' | 'processing' | 'complete' | 'failed'
  ai_error?: string
  created_at: string
  created_by: string
}

export interface AvPalletTagLine {
  awb_number: string
  pieces: number
  weight_kg: number
  remark?: string
}

export interface AvPalletTag {
  id?: string
  flight_id: string
  pallet_number: string
  destination: string
  date: string
  lines: AvPalletTagLine[]
  total_pieces: number
  total_weight_kg: number
  notes?: string[]
  screened: boolean
  screening_cert_id?: string
  screened_at?: string
  screened_by?: string
  doc_url: string
  doc_filename: string
  prepared_by?: string
  ai_status?: 'pending' | 'processing' | 'complete' | 'failed' | 'needs_review'
  ai_error?: string
  ai_processed_at?: string
  created_at: string
  uploaded_by: string
}

export interface AvScreeningCertUld {
  pallet_number: string
  awb?: string
  pieces?: number
  matched: boolean
  pallet_tag_id?: string | null
}

export interface AvScreeningCert {
  id?: string
  flight_id?: string | null
  gmail_message_id?: string
  gmail_subject?: string
  gmail_from?: string
  gmail_date?: string
  content_key?: string
  screener_company: string
  screener_name?: string
  screening_date: string
  screening_time?: string
  mcl_representant?: string
  tsa_entry?: string
  uld_lines?: AvScreeningCertUld[]
  total_ulds?: number
  matched_ulds?: number
  doc_url: string
  doc_filename: string
  status?: 'matched' | 'partial' | 'unmatched' | 'no_uld_lines' | 'duplicate'
  retried_at?: string
  processed_at?: string
  created_at: string
}

export interface AvDgKeyword {
  term: string
  category: string
  severity: 'warning' | 'critical'
  active: boolean
}

export interface AvDgDictionary {
  id: 'default'
  keywords: AvDgKeyword[]
  updated_at: string
  updated_by: string
}

export interface AvBracket {
  min_kg: number
  max_kg: number
  rate_per_kg: number
}

export interface AvBillingBracketConfig {
  id?: string
  period: string
  brackets: AvBracket[]
  active: boolean
  created_at: string
  created_by: string
}

export interface AvBillingCharge {
  id?: string
  flight_id: string
  awb_number: string
  billing_weight_kg: number
  rate_applied: number
  bracket_label: string
  total: number
  status: 'pending' | 'invoiced'
  invoice_id?: string
  period: string
  created_at: string
}

export interface AvInvoice {
  id?: string
  invoice_number: string
  mode: 'flat' | 'brackets'

  // Flat mode: one invoice per flight
  flight_id?: string
  flight_number?: string

  // Brackets mode: quincenal period
  period?: string               // "2026-07-Q1" or "2026-07-Q2"
  period_start?: string         // "2026-07-01"
  period_end?: string           // "2026-07-15"
  due_date?: string             // 15 days after invoice date

  // Flight details (both modes)
  flights: { flight_id: string; flight_number: string; date: string; total_kg: number }[]

  // AWB line items
  lines: {
    flight_number: string
    awb_number: string
    gross_weight_kg: number
    rate: number
    total: number
  }[]

  total_kg: number
  subtotal: number

  // Bracket breakdown (brackets mode only)
  bracket_breakdown: {
    bracket_label: string
    kg_in_bracket: number
    rate: number
    subtotal: number
  }[]

  // Adjustment for bracket recalc at end of month
  adjustment?: number
  adjustment_note?: string

  flat_rate?: number            // rate used in flat mode

  total: number
  status: 'draft' | 'sent' | 'paid' | 'void'
  date: string
  created_at: string
  created_by: string
}

export interface AvBillingConfig {
  mode: 'flat' | 'brackets'
  flat_rate: number              // $/kg when mode=flat
  brackets: AvBracket[]          // when mode=brackets
  updated_at: string
  updated_by: string
}

export interface AvDeliveryOrder {
  id?: string
  do_number: string               // "AV-0000001"
  flight_id: string
  flight_number: string
  date: string
  status: 'draft' | 'dispatched' | 'complete'
  created_at: string
  created_by: string
  updated_at?: string

  // AWBs resolved from pallet tags
  awb_numbers: string[]           // ["729-12345678", ...]
  uld_numbers: string[]           // ["PAG71052R7", ...]

  // Transport
  trucking_company: string
  driver_name: string
  custody_method: 'seal' | 'escort' | 'locked_vehicle'
  seal_number: string
  mcl_agent: string

  // Driver tracking
  driver_pin?: string
  tracking_id?: string | null
}
