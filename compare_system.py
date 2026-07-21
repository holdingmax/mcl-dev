"""
Comparacion: Excel Ideal vs Sistema Actual
"""
import json, re, openpyxl
from datetime import datetime, timedelta
from collections import defaultdict

# Load system export
with open(r'C:\Users\dgarc\Downloads\Agentes MCL\mcl-wms\express-line-export.json', 'r') as f:
    sys_data = json.load(f)

def norm(s):
    return str(s or '').strip().upper()

def flight_key(fn):
    return re.sub(r'[\s\-]', '', norm(fn))

# ============================================================
# BUILD SYSTEM AWB MAP
# ============================================================
sys_awb_map = {}  # normalized awb_number -> system record
sys_awb2_map = {}  # normalized awb_2nd_leg -> system record

flights_by_id = {f['id']: f for f in sys_data['flights']}

for b in sys_data['bookings']:
    fl = flights_by_id.get(b['flight_id'], {})
    for i, line in enumerate(b.get('awb_lines', [])):
        rec = {
            'booking_id': b['id'],
            'flight_id': b['flight_id'],
            'flight_number': fl.get('flight_number') or b.get('flight_number') or '',
            'airline': fl.get('airline') or b.get('airline') or '',
            'flight_datetime': fl.get('flight_datetime') or '',
            'cutoff_datetime': fl.get('cutoff_datetime') or '',
            'flight_status': fl.get('status') or '',
            'destination_id': b.get('destination_id') or '',
            'booking_status': b.get('status') or '',
            'created_by': b.get('created_by') or '',
            'awb_index': i,
            'awb_number': line.get('awb_number') or '',
            'awb_2nd_leg': line.get('awb_2nd_leg') or '',
            'pieces': line.get('pieces', 0),
            'chargeable_weight': line.get('chargeable_weight', 0),
            'uld_type': line.get('uld_type') or '',
            'pickup_from': line.get('pickup_from') or '',
            'ready_for_pickup': line.get('ready_for_pickup') or '',
            'last_day_free': line.get('last_day_free') or '',
            'hold': line.get('hold'),
            'holds': line.get('holds', []),
            'battery': line.get('battery', False),
            'docs_in_drive': line.get('docs_in_drive', False),
            'on_hand': line.get('on_hand', False),
            'dispatched': line.get('dispatched', False),
        }
        a1 = norm(rec['awb_number'])
        a2 = norm(rec['awb_2nd_leg'])
        if a1:
            sys_awb_map[a1] = rec
        if a2:
            sys_awb2_map[a2] = rec

print(f'System: {len(sys_awb_map)} AWBs by 1st leg, {len(sys_awb2_map)} by 2nd leg')

# ============================================================
# LOAD EXCEL (reuse parsing from analyze_sheet.py)
# ============================================================
wb = openpyxl.load_workbook(r'C:\Users\dgarc\Downloads\EXPRESS LINE  BOOKING.xlsx', data_only=True)
ws = wb['May 2026 ']

def parse_date(raw):
    if raw is None or raw == '': return ''
    if isinstance(raw, datetime):
        if raw.hour or raw.minute:
            return raw.strftime('%Y-%m-%dT%H:%M:00')
        return raw.strftime('%Y-%m-%d')
    if isinstance(raw, (int, float)):
        d = datetime(1899, 12, 30) + timedelta(days=raw)
        if raw % 1 != 0:
            return d.strftime('%Y-%m-%dT%H:%M:00')
        return d.strftime('%Y-%m-%d')
    s = str(raw).replace('\r', ' ').replace('\n', ' ').replace('\t', ' ')
    s = re.sub(r'\s+', ' ', s).strip()
    if not s or re.match(r'^[a-z]', s, re.I): return s
    m = re.search(r'(\d{1,2})[/\-](\d{1,2})(?:[/\-](\d{2,4}))?', s)
    if m:
        mm = m.group(1).zfill(2)
        dd = m.group(2).zfill(2)
        yr = m.group(3)
        year = ('20' + yr if len(yr) == 2 else yr) if yr else str(datetime.now().year)
        return f'{year}-{mm}-{dd}'
    return s

def is_yes(val):
    v = str(val or '').lower().strip()
    return v in ('y', 'yes', 'si', 'true', '1')

COL = {
    'doc_status': 1, 'flight': 2, 'awb1': 3, 'awb2': 4,
    'uld': 5, 'pcs': 6, 'cw': 7, 'pickup': 8, 'ready': 9, 'lfd': 10,
    'deliver_to': 11, 'dest': 12, 'cutoff': 13, 'etd': 14,
    'hold_bg': 15, 'hold_box': 16, 'battery': 17, 'segregation': 19,
}

def cell(r, key):
    return str(ws.cell(r, COL[key]+1).value or '').strip()

def cell_raw(r, key):
    return ws.cell(r, COL[key]+1).value

excel_rows = []
cont_holds = []
last_awb_idx = -1

for r in range(2, ws.max_row + 1):
    awb1 = cell(r, 'awb1')
    awb2 = cell(r, 'awb2')
    hold_bg = cell(r, 'hold_bg')
    hold_box = cell(r, 'hold_box')

    if not awb1 and not awb2:
        if hold_bg and last_awb_idx >= 0:
            hbl = hold_bg.lower().strip()
            if hbl and hbl not in ('no hold', 'no', 'n/a'):
                cont_holds.append({'parent': last_awb_idx, 'bag': hold_bg, 'box': hold_box})
        continue

    awb_check = (awb1 or awb2).strip()
    if not re.search(r'\d{3}-\d+', awb_check):
        continue

    last_awb_idx = len(excel_rows)
    pcs_raw = cell_raw(r, 'pcs')
    cw_raw = cell_raw(r, 'cw')

    bg = hold_bg.strip()
    bg_lower = bg.lower()
    is_no = not bg or bg_lower in ('no hold', 'no', 'n/a')
    is_pend = bg_lower in ('pending', 'pendiente')
    hold_list = []
    if not is_no and not is_pend and bg:
        hold_list.append({'bag': bg, 'box': hold_box})
    h_status = 'PENDING' if is_pend else ('HOLD' if not is_no and not is_pend and bg else 'NO HOLD')

    excel_rows.append({
        'row': r,
        'flight': norm(cell(r, 'flight')),
        'awb1': awb1,
        'awb2': awb2,
        'uld': norm(cell(r, 'uld')) or 'LOOSE',
        'pcs': int(float(pcs_raw)) if pcs_raw else 0,
        'cw': float(cw_raw) if cw_raw else 0,
        'pickup': cell(r, 'pickup'),
        'ready': parse_date(cell_raw(r, 'ready')),
        'lfd': parse_date(cell_raw(r, 'lfd')),
        'deliver_to': cell(r, 'deliver_to'),
        'dest': norm(cell(r, 'dest')),
        'cutoff': parse_date(cell_raw(r, 'cutoff')),
        'etd': parse_date(cell_raw(r, 'etd')),
        'hold_bg': hold_bg,
        'hold_box': hold_box,
        'battery': is_yes(cell(r, 'battery')),
        'docs': 'DOCS' in cell(r, 'doc_status').upper(),
        'segregation': cell(r, 'segregation'),
        'holds': hold_list,
        'hold_status': h_status,
    })

for ch in cont_holds:
    if 0 <= ch['parent'] < len(excel_rows):
        excel_rows[ch['parent']]['holds'].append({'bag': ch['bag'], 'box': ch['box']})
        if excel_rows[ch['parent']]['hold_status'] == 'NO HOLD':
            excel_rows[ch['parent']]['hold_status'] = 'HOLD'

print(f'Excel: {len(excel_rows)} AWB rows')

# ============================================================
# COMPARE: Excel vs System
# ============================================================
print('\n' + '=' * 90)
print('COMPARACION FILA POR FILA: Excel Ideal vs Sistema')
print('=' * 90)

matched = []
missing_in_system = []
extra_in_system = set(sys_awb_map.keys())

for ex in excel_rows:
    a1 = norm(ex['awb1'])
    a2 = norm(ex['awb2'])

    sys = sys_awb_map.get(a1) or sys_awb2_map.get(a2)

    if sys:
        extra_in_system.discard(norm(sys['awb_number']))
        matched.append((ex, sys))
    else:
        missing_in_system.append(ex)

print(f'\n  Matched: {len(matched)}')
print(f'  Missing in system: {len(missing_in_system)}')
print(f'  Extra in system (not in May sheet): {len(extra_in_system)}')

# ============================================================
# MISSING IN SYSTEM
# ============================================================
print('\n' + '-' * 90)
print('MISSING IN SYSTEM (AWBs en Excel pero NO en sistema)')
print('-' * 90)

for ex in missing_in_system:
    has_2nd = 'Y' if ex['awb2'] else 'N'
    has_etd = 'Y' if ex['etd'] else 'N'
    reason = []
    if not ex['awb2']: reason.append('sin 2nd leg')
    if not ex['etd']: reason.append('sin ETD')
    if ex['etd'] and not ex['etd'].startswith('202'): reason.append(f'bad year: {ex["etd"]}')
    reason_str = ' | '.join(reason) if reason else 'DEBERIA ESTAR - posible bug'
    print(f'  R{ex["row"]}: {ex["awb1"]} -> {ex["awb2"] or "(none)"} | {ex["flight"]} | ETD:{ex["etd"]} | {reason_str}')

# ============================================================
# MATCHED: FIELD-BY-FIELD COMPARISON
# ============================================================
print('\n' + '-' * 90)
print('DIFERENCIAS EN AWBS MATCHED')
print('-' * 90)

diff_categories = defaultdict(list)
total_diffs = 0

for ex, sys in matched:
    diffs = []

    # Flight number (normalized)
    ex_fk = flight_key(ex['flight'])
    sys_fk = flight_key(sys['flight_number'])
    if ex_fk != sys_fk:
        diffs.append(('FLIGHT', ex['flight'], sys['flight_number']))

    # Pieces
    if ex['pcs'] != sys['pieces']:
        diffs.append(('PCS', str(ex['pcs']), str(sys['pieces'])))

    # CW
    if abs(ex['cw'] - sys['chargeable_weight']) > 0.5:
        diffs.append(('CW', str(ex['cw']), str(sys['chargeable_weight'])))

    # ULD
    ex_uld = norm(ex['uld']) or 'LOOSE'
    sys_uld = norm(sys['uld_type']) or 'LOOSE'
    if ex_uld != sys_uld:
        diffs.append(('ULD', ex_uld, sys_uld))

    # 2nd leg
    if norm(ex['awb2']) != norm(sys['awb_2nd_leg']):
        diffs.append(('2ND_LEG', ex['awb2'], sys['awb_2nd_leg']))

    # Destination (compare normalized - strip suffixes)
    ex_dest_raw = ex['dest']
    ex_dest_norm = re.sub(r'\s+(LOOSE|PAX|CARGO|CAO)$', '', ex_dest_raw).strip()
    sys_dest = norm(sys['destination_id'])
    if ex_dest_norm != sys_dest and ex_dest_raw != sys_dest:
        diffs.append(('DEST', ex_dest_raw, sys_dest))

    # Hold status
    ex_hold = ex['hold_status']
    sys_hold_val = sys['hold']
    if sys_hold_val is True:
        sys_hold = 'HOLD'
    elif sys_hold_val == 'pending':
        sys_hold = 'PENDING'
    else:
        sys_hold = 'NO HOLD'
    if ex_hold != sys_hold:
        diffs.append(('HOLD', ex_hold, sys_hold))

    # Hold count
    ex_holds_count = len(ex['holds'])
    sys_holds_count = len(sys['holds'])
    if ex_holds_count != sys_holds_count and (ex_holds_count > 0 or sys_holds_count > 0):
        diffs.append(('HOLDS_COUNT', str(ex_holds_count), str(sys_holds_count)))

    # Battery
    if ex['battery'] != sys['battery']:
        diffs.append(('BATTERY', 'Y' if ex['battery'] else 'N', 'Y' if sys['battery'] else 'N'))

    # Pickup
    if norm(ex['pickup']) != norm(sys['pickup_from']):
        diffs.append(('PICKUP', ex['pickup'], sys['pickup_from']))

    # Docs
    if ex['docs'] != sys['docs_in_drive']:
        diffs.append(('DOCS', 'Y' if ex['docs'] else 'N', 'Y' if sys['docs_in_drive'] else 'N'))

    # ETD (only compare date part since system may have different time)
    ex_etd_date = (ex['etd'] or '')[:10]
    sys_etd_date = (sys['flight_datetime'] or '')[:10]
    if ex_etd_date and sys_etd_date and ex_etd_date != sys_etd_date:
        diffs.append(('ETD_DATE', ex['etd'], sys['flight_datetime']))

    if diffs:
        total_diffs += len(diffs)
        for field, ex_val, sys_val in diffs:
            diff_categories[field].append({
                'row': ex['row'],
                'awb': ex['awb1'],
                'excel': ex_val,
                'system': sys_val,
            })

# Print by category
for field in sorted(diff_categories.keys()):
    items = diff_categories[field]
    print(f'\n  {field} ({len(items)} diferencias):')
    for item in items[:15]:
        print(f'    R{item["row"]}: {item["awb"]} | Excel: {item["excel"][:40]} | Sistema: {item["system"][:40]}')
    if len(items) > 15:
        print(f'    ... y {len(items) - 15} mas')

print(f'\n  Total diferencias en campos: {total_diffs}')

# ============================================================
# EXTRA IN SYSTEM (not in May sheet)
# ============================================================
print('\n' + '-' * 90)
print(f'EXTRA IN SYSTEM ({len(extra_in_system)} AWBs en sistema pero NO en sheet de Mayo)')
print('-' * 90)

# Group by flight month
extra_by_month = defaultdict(list)
for awb_key in sorted(extra_in_system):
    rec = sys_awb_map[awb_key]
    etd = (rec['flight_datetime'] or '')[:7]
    extra_by_month[etd].append(rec)

for month in sorted(extra_by_month.keys()):
    recs = extra_by_month[month]
    print(f'\n  {month or "no-ETD"}: {len(recs)} AWBs')
    for rec in recs[:10]:
        print(f'    {rec["awb_number"]} -> {rec["awb_2nd_leg"]} | {rec["flight_number"]} | ETD: {(rec["flight_datetime"] or "")[:10]} | by: {rec["created_by"]}')
    if len(recs) > 10:
        print(f'    ... y {len(recs) - 10} mas')

# ============================================================
# SYSTEM FLIGHTS ANALYSIS
# ============================================================
print('\n' + '-' * 90)
print('ANALISIS DE VUELOS DEL SISTEMA')
print('-' * 90)

# May flights only
may_flights = [f for f in sys_data['flights'] if (f.get('flight_datetime') or '').startswith('2026-05')]
print(f'\n  Total vuelos Mayo: {len(may_flights)}')

# Check for duplicates
flight_groups = defaultdict(list)
for f in may_flights:
    fk = flight_key(f['flight_number'])
    etd_date = (f.get('flight_datetime') or '')[:10]
    key = f'{fk}|{etd_date}'
    flight_groups[key].append(f)

dups = {k: v for k, v in flight_groups.items() if len(v) > 1}
if dups:
    print(f'\n  VUELOS DUPLICADOS (mismo flight_key + ETD date):')
    for key, fls in dups.items():
        print(f'    {key}:')
        for f in fls:
            # Count AWBs in this flight
            awb_count = sum(len(b['awb_lines']) for b in sys_data['bookings'] if b['flight_id'] == f['id'])
            print(f'      {f["id"][:8]} | {f["flight_number"]:>14} | ETD: {f["flight_datetime"][:22]} | by: {f["created_by"]} | {awb_count} AWBs')

# Flight naming issues
print(f'\n  Variantes de nombre de vuelo (Mayo):')
name_variants = defaultdict(set)
for f in may_flights:
    fk = flight_key(f['flight_number'])
    name_variants[fk].add(f['flight_number'])
for fk in sorted(name_variants.keys()):
    names = name_variants[fk]
    if len(names) > 1:
        print(f'    {fk}: {sorted(names)} *** INCONSISTENTE')
    else:
        print(f'    {fk}: {sorted(names)}')

# ============================================================
# SUMMARY
# ============================================================
print('\n' + '=' * 90)
print('RESUMEN DE COMPARACION')
print('=' * 90)

# Count May AWBs in system
may_awbs_in_system = 0
for b in sys_data['bookings']:
    fl = flights_by_id.get(b['flight_id'], {})
    etd = fl.get('flight_datetime') or ''
    if etd.startswith('2026-05'):
        may_awbs_in_system += len(b.get('awb_lines', []))

print(f'''
  Excel May 2026:
    Total filas con AWB: {len(excel_rows)}
    Matched con sistema: {len(matched)}
    Missing en sistema:  {len(missing_in_system)}

  Sistema:
    Total AWB lines:     {len(sys_awb_map)}
    AWBs de Mayo:        {may_awbs_in_system}
    Extra (no en sheet): {len(extra_in_system)}

  Diferencias en matched:
    Total campos diff:   {total_diffs}
    Categorias:          {", ".join(f"{k}({len(v)})" for k, v in sorted(diff_categories.items()))}

  Vuelos Mayo:
    En sistema:          {len(may_flights)}
    Duplicados:          {len(dups)}
''')
