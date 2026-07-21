export interface EmailRecipient {
  name: string
  email: string
}

// Default recipients when a WR has no client-specific email list
export const WR_EMAIL_RECIPIENTS: EmailRecipient[] = [
  { name: 'Daniela Vidal',      email: 'dsvidale@sodimac.cl' },
  { name: 'Diana Iglesias',     email: 'ext_diglesiase@sodimac.cl' },
  { name: 'Omar Bustos',        email: 'obustosa@sodimac.cl' },
  { name: 'Gonzalo Córdova',    email: 'gandcordovam@sodimac.cl' },
  { name: 'Elizabeth Gallardo', email: 'ext_elizagallardof@sodimac.cl' },
]

// Always CC'd on every outgoing email (WR + dispatches)
export const MCL_CC_RECIPIENTS: EmailRecipient[] = [
  { name: 'Diego Garcia', email: 'diego.garcia@mincurllogistics.com' },
  { name: 'Elias Hane',   email: 'elias.hane@mincurllogistics.com' },
  { name: 'Erick Duran',  email: 'erick.duran@mincurllogistics.com' },
]
