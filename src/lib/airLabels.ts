// Lightweight conditional labels for airfreight (EN for ecommerce, ES default)

const LABELS_EN = {
  // Dashboard
  open_flights: 'Open Flights',
  closed_flights: 'Closed',
  all_flights: 'All',
  new_booking: 'New Booking',
  uld_control: 'ULD Control',
  holds: 'Holds',
  transportation: 'Transportation',
  // Flight table
  client: 'Client',
  airline: 'Airline',
  flight_number: 'Flight#',
  etd: 'ETD',
  destination: 'Dest.',
  awbs: 'AWBs',
  pieces: 'PCs',
  weight: 'KG',
  chargeable_weight: 'CHW',
  holds_col: 'Holds',
  dg: 'DG',
  lb: 'LB',
  docs: 'Docs',
  dist: 'Dist',
  status: 'Status',
  // Booking
  upload_booking: 'Upload Booking',
  awb_1st_leg: 'AWB 1st Leg',
  awb_2nd_leg: 'AWB 2nd Leg',
  uld_type: 'ULD Type',
  weight_label: 'Weight',
  chw_label: 'Chargeable Wt',
  battery: 'Battery',
  hold_label: 'Hold',
  // Transportation
  awb_number: 'AWB#',
  pickup_from: 'Pick Up From',
  ready_for_pickup: 'Ready for Pick Up',
  last_day_free: 'Last Day Free',
  transport_status: 'Status',
  transport_company: 'Transport Co.',
  transport_documents: 'Documents',
  actions: 'Actions',
  // Holds
  bag: 'Bag#',
  box: 'Box#',
  photo: 'Photo',
  // Hold statuses
  informed: 'Informed',
  photo_taken: 'Photo Taken',
  cbp_released: 'CBP Released',
  pending_instruction: 'Pending',
  fly: 'Fly',
  send_do: 'Send DO',
  completed: 'Completed',
} as const

const LABELS_ES: Record<keyof typeof LABELS_EN, string> = {
  // Dashboard
  open_flights: 'Vuelos Abiertos',
  closed_flights: 'Cerrados',
  all_flights: 'Todos',
  new_booking: 'Nuevo Booking',
  uld_control: 'Control ULD',
  holds: 'Holds',
  transportation: 'Transportation',
  // Flight table
  client: 'Cliente',
  airline: 'Aerolinea',
  flight_number: 'Vuelo',
  etd: 'ETD',
  destination: 'Destino',
  awbs: 'AWBs',
  pieces: 'PCS',
  weight: 'KG',
  chargeable_weight: 'CHW',
  holds_col: 'Holds',
  dg: 'DG',
  lb: 'LB',
  docs: 'Docs',
  dist: 'Dist',
  status: 'Estado',
  // Booking
  upload_booking: 'Subir Excel',
  awb_1st_leg: 'AWB 1st Leg',
  awb_2nd_leg: 'AWB 2nd Leg',
  uld_type: 'Tipo ULD',
  weight_label: 'Peso',
  chw_label: 'Peso Cobrable',
  battery: 'Bateria',
  hold_label: 'Hold',
  // Transportation
  awb_number: 'AWB#',
  pickup_from: 'Pick Up From',
  ready_for_pickup: 'Ready for Pick Up',
  last_day_free: 'Last Day Free',
  transport_status: 'Estado',
  transport_company: 'Transport Co.',
  transport_documents: 'Documentos',
  actions: 'Acciones',
  // Holds
  bag: 'Bolsa#',
  box: 'Caja#',
  photo: 'Foto',
  // Hold statuses
  informed: 'Informado',
  photo_taken: 'Foto',
  cbp_released: 'CBP Released',
  pending_instruction: 'Pendiente',
  fly: 'Volar',
  send_do: 'Enviar DO',
  completed: 'Completado',
}

export type LabelKey = keyof typeof LABELS_EN

export function airLabel(key: LabelKey, isEcommerce: boolean): string {
  return isEcommerce ? LABELS_EN[key] : LABELS_ES[key]
}

export function getLabels(isEcommerce: boolean) {
  return isEcommerce ? LABELS_EN : LABELS_ES
}
