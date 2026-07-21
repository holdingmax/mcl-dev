import type { AvFlightAwb } from '../types'

function fmtDate(d?: string): string {
  if (!d) return new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
  return new Date(d).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
}

export type LbAnswer = 'yes' | 'no' | 'na'

export interface LbChecklistAnswers {
  [key: number]: LbAnswer
}

export const LB_DEFAULTS: LbChecklistAnswers = {
  1: 'yes', 2: 'yes', 3: 'na', 4: 'yes', 5: 'yes', 6: 'na', 7: 'na', 8: 'na',
  9: 'yes', 10: 'yes', 11: 'yes', 12: 'na', 13: 'na', 14: 'na', 15: 'yes', 16: 'na',
}

export interface LbChecklistData {
  awb: AvFlightAwb & { id: string }
  answers: LbChecklistAnswers
  flightNumber: string
  destination: string
}

interface Question {
  num: number
  text: string
  hasNa: boolean
}

const QUESTIONS: { section: string; partLabel?: string; items: Question[] }[] = [
  {
    section: 'I. Air Waybill',
    items: [
      { num: 1, text: 'The AWB shows the words "Lithium Ion / Lithium Metal / Sodium Ion batteries in compliance with Section II of PI 966/967/969/970/977/978"', hasNa: false },
    ],
  },
  {
    section: 'II. Lithium and Sodium Battery Shipment\'s Declaration, Section II (UN3091/UN3481/UN3552)',
    partLabel: 'Part No. 1',
    items: [
      { num: 2, text: 'For direct shipments master air waybill number — MAWB', hasNa: true },
      { num: 3, text: 'House air waybill number — HAWB', hasNa: true },
      { num: 4, text: 'Shipper and consignee information', hasNa: true },
    ],
  },
  {
    section: '__part2',
    partLabel: 'Part No. 2',
    items: [
      { num: 5, text: 'Selected the applicable battery type', hasNa: true },
      { num: 6, text: 'Pieces number', hasNa: true },
      { num: 7, text: 'AWB weight of batteries per package', hasNa: true },
    ],
  },
  {
    section: '__part3',
    partLabel: 'Part No. 3',
    items: [
      { num: 8, text: 'Contact phone number', hasNa: true },
    ],
  },
  {
    section: 'III. Package, Marks and Labels',
    items: [
      { num: 9, text: 'The package is in good condition and is not damaged', hasNa: false },
      { num: 10, text: 'The package complies with the outer packaging described in the packaging instruction', hasNa: false },
      { num: 11, text: 'Each package durably and legibly marked with the battery mark — see figure 7.1C DGR IATA', hasNa: false },
    ],
  },
  {
    section: 'IV. Overpack',
    items: [
      { num: 12, text: 'The overpack marked with the word "OVERPACK"', hasNa: true },
      { num: 13, text: 'The overpack has the mark of batteries and is visible', hasNa: true },
      { num: 14, text: 'Packages are secured inside the overpack', hasNa: true },
    ],
  },
  {
    section: 'V. General',
    items: [
      { num: 15, text: 'The shipment complies with the variations of states and operators', hasNa: true },
      { num: 16, text: 'Cargo plane operates all the route for "CAO" shipments', hasNa: true },
    ],
  },
]

export { QUESTIONS }

function chk(answer: LbAnswer, target: LbAnswer): string {
  return answer === target ? '&#10003;' : '&#9744;'
}

function chkStyle(answer: LbAnswer, target: LbAnswer): string {
  const checked = answer === target
  return `<span style="font-size:11pt;${checked ? 'font-weight:bold;' : 'color:#bbb;'}">${chk(answer, target)}</span>`
}

export function buildAvLbChecklistHtml({ awb, answers, flightNumber, destination }: LbChecklistData): string {
  const phone = awb.shipper_phone || ''
  const awbNum = awb.awb_number || ''

  // Build questions HTML — document-style layout like original PDF
  let questionsHtml = ''

  for (const group of QUESTIONS) {
    // Section header
    if (!group.section.startsWith('__')) {
      questionsHtml += `<div style="font-weight:bold;font-size:9.5pt;margin-top:12px;margin-bottom:2px;">${group.section}</div>`
      // Subheading for section I
      if (group.section.startsWith('I.')) {
        questionsHtml += `<div style="font-size:8pt;margin-left:10px;margin-bottom:4px;color:#333;">The air waybill must contain the following information and must be shown in the "Nature and quantity of goods" space</div>`
      }
    }
    if (group.partLabel) {
      questionsHtml += `<div style="font-weight:bold;font-size:8.5pt;margin-top:6px;margin-left:10px;margin-bottom:2px;">${group.partLabel}</div>`
    }

    for (const q of group.items) {
      const a = answers[q.num] || 'na'
      let displayText = q.text
      if (q.num === 2) displayText += ` <b>${awbNum}</b>`
      if (q.num === 8 && phone) displayText += ` <b>${phone}</b>`

      const yesNoNa = q.hasNa
        ? `YES ${chkStyle(a, 'yes')}&nbsp;&nbsp;NO ${chkStyle(a, 'no')}&nbsp;&nbsp;N/A ${chkStyle(a, 'na')}`
        : `YES ${chkStyle(a, 'yes')}&nbsp;&nbsp;NO ${chkStyle(a, 'no')}`

      questionsHtml += `<div style="display:flex;align-items:flex-start;margin:3px 0 3px 20px;font-size:8.5pt;line-height:1.5;">
        <div style="min-width:22px;font-weight:bold;">${q.num}.</div>
        <div style="flex:1;">${displayText}</div>
        <div style="min-width:160px;text-align:right;white-space:nowrap;padding-left:12px;">${yesNoNa}</div>
      </div>`
    }
  }

  const hasNo = Object.values(answers).some(v => v === 'no')

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<style>
  @page { margin: 0.4in 0.5in; size: letter; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .no-print { display: none !important; } }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, 'Segoe UI', sans-serif; font-size: 8.5pt; color: #1a1a1a; padding: 20px 28px; background: #fff; }
  .print-btn { position: fixed; top: 10px; right: 10px; background: #c8102e; color: #fff; border: none; padding: 8px 18px; border-radius: 6px; font-size: 11pt; font-weight: 700; cursor: pointer; z-index: 100; }
  .print-btn:hover { background: #a00d24; }
</style>
</head><body>
<button class="print-btn no-print" onclick="window.print()">Imprimir</button>

<!-- HEADER -->
<table style="width:100%;border-collapse:collapse;border:1.5px solid #333;">
  <tr>
    <td rowspan="2" style="width:140px;text-align:center;vertical-align:middle;border:1.5px solid #333;padding:8px;">
      <span style="font-size:18pt;font-weight:900;font-family:'Arial Black',Arial,sans-serif;">Avianca Group</span>
    </td>
    <td rowspan="2" style="text-align:center;vertical-align:middle;border:1.5px solid #333;padding:8px;">
      <div style="font-weight:bold;font-size:9pt;">FR_NE0803_06</div>
      <div style="font-size:8pt;">CHECKLIST FOR ACCEPTANCE OF LITHIUM AND</div>
      <div style="font-size:8pt;">SODIUM BATTERIES SECTION II PI966, PI967,</div>
      <div style="font-size:8pt;">PI969, PI970, PI977, PI978</div>
    </td>
    <td style="width:130px;text-align:center;border:1.5px solid #333;padding:4px;font-size:8pt;">
      Revision date:<br><b>2024-12-12</b>
    </td>
  </tr>
  <tr>
    <td style="text-align:center;border:1.5px solid #333;padding:4px;font-size:8pt;">
      Rev.: <b>08</b>
    </td>
  </tr>
</table>

<!-- SUBTITLE -->
<div style="text-align:center;margin-top:14px;font-weight:bold;font-size:9pt;text-transform:uppercase;">
  THE CHECKLIST MUST DO AT THE SHIPMENT'S STATE OF ORIGINS
</div>
<div style="text-align:center;margin-top:6px;font-weight:bold;font-size:8.5pt;">
  The shipment must not be accepted or rejected before having verified all the items
</div>
<div style="text-align:center;margin-top:8px;font-size:8.5pt;font-style:italic;">
  Is the following information correct for each of the items?
</div>

<!-- AWB INFO BANNER -->
<div style="display:flex;gap:0;border:1.5px solid #333;margin-top:10px;">
  <div style="flex:1;padding:4px 10px;border-right:1px solid #999;">
    <div style="font-size:6.5pt;text-transform:uppercase;color:#888;font-weight:600;">AWB Number</div>
    <div style="font-size:9pt;font-weight:700;font-family:Consolas,monospace;">${awbNum}</div>
  </div>
  <div style="flex:1;padding:4px 10px;border-right:1px solid #999;">
    <div style="font-size:6.5pt;text-transform:uppercase;color:#888;font-weight:600;">Shipper</div>
    <div style="font-size:8pt;font-weight:700;">${awb.shipper_name || ''}</div>
  </div>
  <div style="flex:1;padding:4px 10px;border-right:1px solid #999;">
    <div style="font-size:6.5pt;text-transform:uppercase;color:#888;font-weight:600;">Consignee</div>
    <div style="font-size:8pt;font-weight:700;">${awb.consignee_name || ''}</div>
  </div>
  <div style="padding:4px 10px;border-right:1px solid #999;">
    <div style="font-size:6.5pt;text-transform:uppercase;color:#888;font-weight:600;">Pcs / Weight</div>
    <div style="font-size:9pt;font-weight:700;">${awb.pieces || ''} pcs / ${awb.gross_weight_kg ? awb.gross_weight_kg.toLocaleString() : ''} K</div>
  </div>
  <div style="padding:4px 10px;">
    <div style="font-size:6.5pt;text-transform:uppercase;color:#888;font-weight:600;">Flight / Dest</div>
    <div style="font-size:9pt;font-weight:700;">${flightNumber} / ${destination}</div>
  </div>
</div>

<!-- QUESTIONS -->
${questionsHtml}

<!-- ACCEPTED / REJECTED -->
<div style="display:flex;align-items:center;justify-content:center;gap:20px;margin-top:20px;">
  <div style="display:flex;align-items:center;gap:10px;">
    <span style="font-size:11pt;font-weight:900;letter-spacing:1px;">ACCEPTED</span>
    <div style="width:100px;height:40px;border:1.5px solid #333;${!hasNo ? 'position:relative;' : ''}">
      ${!hasNo ? '<div style="position:absolute;top:2px;left:8px;font-size:24pt;color:#333;">&#10003;</div>' : ''}
    </div>
  </div>
  <div style="display:flex;align-items:center;gap:10px;">
    <span style="font-size:11pt;font-weight:900;letter-spacing:1px;">REJECTED</span>
    <div style="width:100px;height:40px;border:1.5px solid #333;${hasNo ? 'position:relative;' : ''}">
      ${hasNo ? '<div style="position:absolute;top:2px;left:8px;font-size:24pt;color:#333;">&#10003;</div>' : ''}
    </div>
  </div>
</div>

<!-- NOTE -->
<div style="margin-top:14px;font-size:7.5pt;line-height:1.5;">
  <b>Note:</b> If the answer to one or more items is <b>NO</b>, notify to the shipper, commercial team and the contact number indicated in the shipper's documentation. Additionally, <b>reject the cargo or put it in hold</b> until the shipment is normalized (Keep a copy of this list together with the flight documents and send a copy to the client).
</div>

<!-- COMMENTS BOX -->
<div style="border:1.5px solid #333;margin-top:14px;min-height:60px;padding:6px 10px;">
  <div style="font-weight:bold;font-size:8pt;">Comments:</div>
</div>

<!-- FOOTER FIELDS -->
<div style="margin-top:20px;">
  <div style="display:flex;align-items:flex-end;margin-bottom:16px;">
    <span style="font-size:8.5pt;min-width:280px;">Checked by:</span>
    <div style="flex:1;border-bottom:1.5px solid #333;min-height:16px;"></div>
  </div>
  <div style="display:flex;align-items:flex-end;margin-bottom:16px;">
    <span style="font-size:8.5pt;min-width:280px;">Signature:</span>
    <div style="flex:1;border-bottom:1.5px solid #333;min-height:16px;"></div>
  </div>
  <div style="display:flex;align-items:flex-end;margin-bottom:16px;">
    <span style="font-size:8.5pt;min-width:280px;">Date and time:</span>
    <div style="flex:1;border-bottom:1.5px solid #333;min-height:16px;font-size:8.5pt;font-weight:600;">${fmtDate()} — ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</div>
  </div>
  <div style="display:flex;align-items:flex-end;margin-bottom:16px;">
    <span style="font-size:8.5pt;min-width:280px;">Name of the shipper's representative:</span>
    <div style="flex:1;border-bottom:1.5px solid #333;min-height:16px;font-size:8.5pt;font-weight:600;">${awb.agent_name || awb.shipper_name || ''}</div>
  </div>
  <div style="display:flex;align-items:flex-end;margin-bottom:8px;">
    <span style="font-size:8.5pt;min-width:280px;">Phone number of the shipper's representative:</span>
    <div style="flex:1;border-bottom:1.5px solid #333;min-height:16px;font-size:8.5pt;font-weight:600;">${phone}</div>
  </div>
</div>

<div style="margin-top:10px;display:flex;justify-content:space-between;font-size:6.5pt;color:#999;">
  <span>Uncontrolled printed copy &nbsp;&nbsp;&nbsp; FR_NE0803_06 R08</span>
  <span>MinCurl Logistics LLC — AWB ${awbNum} — ${new Date().toLocaleString('en-US')}</span>
</div>

</body></html>`
}
