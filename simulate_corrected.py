"""
Simulacion del agente con TODAS las reglas corregidas.
Genera el estado esperado completo del sistema.
NO modifica nada - solo analisis.
"""
import openpyxl, re, json
from datetime import datetime, timedelta
from collections import defaultdict

wb = openpyxl.load_workbook(r'C:\Users\dgarc\Downloads\EXPRESS LINE  BOOKING.xlsx', data_only=True)
ws = wb['May 2026 ']

# ============================================================
# REGLA CORREGIDA: sheetParseDate con preservacion de hora
# ============================================================
def parse_date_CURRENT(raw):
    """Parser ACTUAL del agente - pierde hora de texto"""
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

def parse_date_CORRECTED(raw):
    """Parser CORREGIDO - preserva hora de texto multilinea"""
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

    # Extract date part
    m = re.search(r'(\d{1,2})[/\-](\d{1,2})(?:[/\-](\d{2,4}))?', s)
    if not m:
        return s

    mm = m.group(1).zfill(2)
    dd = m.group(2).zfill(2)
    yr = m.group(3)
    year = ('20' + yr if len(yr) == 2 else yr) if yr else str(datetime.now().year)

    # CORRECTED: also extract time if present
    # Match patterns like "09:55", "5:30 pm", "23:40", "noon", "8PM", "13:00"
    time_match = re.search(r'(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)?', s)
    if not time_match:
        # Try "noon" or standalone "Xpm/Xam"
        noon_match = re.search(r'\bnoon\b', s, re.I)
        if noon_match:
            return f'{year}-{mm}-{dd}T12:00:00'
        standalone_time = re.search(r'(\d{1,2})\s*(am|pm|AM|PM)', s)
        if standalone_time:
            h = int(standalone_time.group(1))
            ap = standalone_time.group(2).lower()
            if ap == 'pm' and h < 12: h += 12
            if ap == 'am' and h == 12: h = 0
            return f'{year}-{mm}-{dd}T{str(h).zfill(2)}:00:00'
        return f'{year}-{mm}-{dd}'

    h = int(time_match.group(1))
    mi = int(time_match.group(2))
    ap = (time_match.group(3) or '').lower()
    if ap == 'pm' and h < 12: h += 12
    if ap == 'am' and h == 12: h = 0

    return f'{year}-{mm}-{dd}T{str(h).zfill(2)}:{str(mi).zfill(2)}:00'


# ============================================================
# REGLA CORREGIDA: Flight normalization
# ============================================================
def normalize_flight_CURRENT(f):
    """Actual: solo uppercase"""
    return str(f or '').strip().upper()

def normalize_flight_CORRECTED(f):
    """Corregido: uppercase + strip hyphens/spaces for matching"""
    base = str(f or '').strip().upper()
    # Keep the original for display, but normalize for matching
    return base

def flight_match_key(f):
    """Key for matching flights: strip hyphens and spaces"""
    return re.sub(r'[\s\-]', '', str(f or '').strip().upper())


# ============================================================
# REGLA CORREGIDA: Destination normalization
# ============================================================
def normalize_dest_CURRENT(d):
    """Actual: solo uppercase+trim"""
    return str(d or '').strip().upper()

def normalize_dest_CORRECTED(d):
    """Corregido: strip suffixes LOOSE, PAX; trim trailing spaces"""
    base = str(d or '').strip().upper()
    base = re.sub(r'\s+(LOOSE|PAX|CARGO|CAO)$', '', base)
    return base.strip()


# ============================================================
# REGLA CORREGIDA: Year validation
# ============================================================
def validate_year(date_str, row_num):
    """Detect bad years"""
    if not date_str: return date_str, None
    m = re.match(r'^(\d{4})-', date_str)
    if m:
        year = int(m.group(1))
        if year < 2020 or year > 2035:
            return None, f'R{row_num}: BAD YEAR {year} in date {date_str}'
    return date_str, None


# ============================================================
# Parse all rows (same logic as agent)
# ============================================================
def is_yes(val):
    v = str(val or '').lower().strip()
    return v in ('y', 'yes', 'si', 'true', '1')

COL = {
    'inbond': 0, 'doc_status': 1, 'flight': 2, 'awb1': 3, 'awb2': 4,
    'uld': 5, 'pcs': 6, 'cw': 7, 'pickup': 8, 'ready': 9, 'lfd': 10,
    'deliver_to': 11, 'dest': 12, 'cutoff': 13, 'etd': 14,
    'hold_bg': 15, 'hold_box': 16, 'battery': 17, 'on_hand': 18,
    'segregation': 19, 'dropped_off': 20, 'vuelo_num': 21
}

def cell(r, key):
    return str(ws.cell(r, COL[key]+1).value or '').strip()

def cell_raw(r, key):
    return ws.cell(r, COL[key]+1).value

rows = []
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

    last_awb_idx = len(rows)

    flight_raw = cell(r, 'flight')
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

    # Pickup validation
    pickup_raw = cell(r, 'pickup')
    pickup_valid = pickup_raw
    pickup_issue = None
    try:
        float(pickup_raw)
        pickup_issue = f'NUMERIC pickup_from "{pickup_raw}" (probable CW duplicate)'
        pickup_valid = ''  # corrected: clear it
    except ValueError:
        pass

    # Segregation (NEW FIELD - currently unmapped)
    segregation = cell(r, 'segregation')

    rows.append({
        'row': r,
        'flight_raw': flight_raw,
        'flight_current': normalize_flight_CURRENT(flight_raw),
        'flight_corrected': normalize_flight_CORRECTED(flight_raw),
        'flight_match_key': flight_match_key(flight_raw),
        'awb1': awb1,
        'awb2': awb2,
        'uld': str(cell(r, 'uld') or '').strip().upper() or 'LOOSE',
        'pcs': int(float(pcs_raw)) if pcs_raw else 0,
        'cw': float(cw_raw) if cw_raw else 0,
        'pickup_raw': pickup_raw,
        'pickup_corrected': pickup_valid,
        'pickup_issue': pickup_issue,
        'ready_current': parse_date_CURRENT(cell_raw(r, 'ready')),
        'ready_corrected': parse_date_CORRECTED(cell_raw(r, 'ready')),
        'lfd_current': parse_date_CURRENT(cell_raw(r, 'lfd')),
        'lfd_corrected': parse_date_CORRECTED(cell_raw(r, 'lfd')),
        'deliver_to': cell(r, 'deliver_to'),
        'dest_current': normalize_dest_CURRENT(cell(r, 'dest')),
        'dest_corrected': normalize_dest_CORRECTED(cell(r, 'dest')),
        'cutoff_current': parse_date_CURRENT(cell_raw(r, 'cutoff')),
        'cutoff_corrected': parse_date_CORRECTED(cell_raw(r, 'cutoff')),
        'etd_current': parse_date_CURRENT(cell_raw(r, 'etd')),
        'etd_corrected': parse_date_CORRECTED(cell_raw(r, 'etd')),
        'hold_bg': hold_bg,
        'hold_box': hold_box,
        'battery': is_yes(cell(r, 'battery')),
        'docs': 'DOCS' in cell(r, 'doc_status').upper(),
        'on_hand_raw': cell(r, 'on_hand'),
        'segregation': segregation,
        'dropped_raw': cell(r, 'dropped_off'),
        'holds': hold_list,
        'hold_status': h_status,
    })

# Merge continuation holds
for ch in cont_holds:
    if 0 <= ch['parent'] < len(rows):
        rows[ch['parent']]['holds'].append({'bag': ch['bag'], 'box': ch['box']})
        if rows[ch['parent']]['hold_status'] == 'NO HOLD':
            rows[ch['parent']]['hold_status'] = 'HOLD'

# ============================================================
# VALIDATE YEARS
# ============================================================
year_issues = []
for r in rows:
    for field in ['etd_corrected', 'cutoff_corrected']:
        val, issue = validate_year(r[field], r['row'])
        if issue:
            year_issues.append(issue)
            r[field + '_valid'] = None
            r[field.replace('corrected', 'year_issue')] = issue
        else:
            r[field + '_valid'] = val

# ============================================================
# CORRECTED ELIGIBILITY (relaxed: allow missing 2nd leg)
# ============================================================
print('=' * 80)
print('SIMULACION CON REGLAS CORREGIDAS')
print('=' * 80)

eligible_current = []
eligible_corrected = []
skipped_current = []
skipped_corrected = []

for r in rows:
    # CURRENT rules: need flight + ETD + 2nd leg
    has_flight = bool(r['flight_current'])
    has_etd_cur = bool(r['etd_current'])
    has_2nd = bool(r['awb2'])
    if has_flight and has_etd_cur and has_2nd:
        eligible_current.append(r)
    else:
        reasons = []
        if not has_flight: reasons.append('no flight')
        if not has_etd_cur: reasons.append('no ETD')
        if not has_2nd: reasons.append('no 2nd leg')
        skipped_current.append((r, reasons))

    # CORRECTED rules: allow missing 2nd leg, allow missing ETD (create as PENDING)
    has_etd_cor = bool(r['etd_corrected'])
    etd_year_ok = r.get('etd_corrected_valid') is not None if 'etd_corrected_valid' in r else has_etd_cor
    # Still require valid AWB and flight
    if has_flight:
        eligible_corrected.append(r)
    else:
        skipped_corrected.append((r, ['no flight']))

print(f'\nEligibilidad:')
print(f'  ACTUAL:    {len(eligible_current)} elegibles, {len(skipped_current)} saltados')
print(f'  CORREGIDO: {len(eligible_corrected)} elegibles, {len(skipped_corrected)} saltados')
print(f'  DIFERENCIA: +{len(eligible_corrected) - len(eligible_current)} AWBs recuperados')

if skipped_corrected:
    print(f'\n  Aun saltados con reglas corregidas:')
    for r, reasons in skipped_corrected:
        print(f'    R{r["row"]}: {r["awb1"]} - {", ".join(reasons)}')

recovered = []
for r, reasons in skipped_current:
    if r in eligible_corrected:
        recovered.append(r)
if recovered:
    print(f'\n  AWBs RECUPERADOS con reglas corregidas ({len(recovered)}):')
    for r in recovered:
        etd = r['etd_corrected'] or '(sin ETD -> PENDING)'
        a2 = r['awb2'] or '(sin 2nd leg)'
        print(f'    R{r["row"]}: {r["awb1"]} -> {a2} | flight={r["flight_corrected"]} | ETD={etd}')

# ============================================================
# BUILD EXPECTED FLIGHTS (corrected)
# ============================================================
print('\n' + '=' * 80)
print('VUELOS ESPERADOS (con reglas corregidas)')
print('=' * 80)

# Group by normalized flight match key + ETD date
flight_groups = defaultdict(list)
pending_awbs = []

for r in eligible_corrected:
    fn = r['flight_corrected']
    fkey = r['flight_match_key']

    # Check if PENDING flight
    is_pending = not fn or re.match(r'^(PENDING|TBD|TBA|N/?A)$', fn, re.I)

    etd = r.get('etd_corrected_valid', r['etd_corrected'])
    if not etd:
        # No ETD -> treat as pending regardless of flight
        is_pending = True

    if is_pending:
        pending_awbs.append(r)
    else:
        etd_date = (etd or '')[:10]
        group_key = f'{fkey}|{etd_date}'
        flight_groups[group_key].append(r)

# Determine canonical flight name per match key
canonical_names = {}
for group_key, awbs in flight_groups.items():
    fkey = group_key.split('|')[0]
    # Use the most common variant (or the one with hyphen if exists)
    names = [a['flight_corrected'] for a in awbs]
    name_counts = defaultdict(int)
    for n in names:
        name_counts[n] += 1
    # Prefer the variant WITH hyphen (standard IATA format)
    best = sorted(name_counts.keys(), key=lambda n: (-name_counts[n], '-' not in n))
    canonical_names[fkey] = best[0]

expected_flights = []
flight_id = 0
for group_key in sorted(flight_groups.keys()):
    awbs = flight_groups[group_key]
    fkey, etd_date = group_key.split('|')
    canonical = canonical_names[fkey]

    # Get unique ETDs (corrected, with time)
    etds_with_time = set()
    cutoffs_with_time = set()
    dests = set()
    airlines = set()

    for a in awbs:
        etd_full = a.get('etd_corrected_valid', a['etd_corrected']) or ''
        if etd_full:
            etds_with_time.add(etd_full)
        co = a.get('cutoff_corrected_valid', a['cutoff_corrected']) or ''
        if co:
            cutoffs_with_time.add(co)
        dests.add(a['dest_corrected'])
        if a['deliver_to']:
            airlines.add(a['deliver_to'])

    # Pick best ETD (with time if available)
    etd_best = sorted(etds_with_time, key=lambda x: len(x), reverse=True)[0] if etds_with_time else etd_date
    cutoff_best = sorted(cutoffs_with_time, key=lambda x: len(x), reverse=True)[0] if cutoffs_with_time else ''

    flight_id += 1
    flight = {
        'id': f'F{flight_id:03d}',
        'flight_number': canonical,
        'flight_match_key': fkey,
        'etd': etd_best,
        'etd_date': etd_date,
        'cutoff': cutoff_best,
        'destinations': sorted(dests),
        'airlines': sorted(airlines),
        'awb_count': len(awbs),
        'total_pcs': sum(a['pcs'] for a in awbs),
        'total_cw': sum(a['cw'] for a in awbs),
        'awbs': awbs,
    }
    expected_flights.append(flight)

# Add PENDING flight if needed
if pending_awbs:
    flight_id += 1
    expected_flights.append({
        'id': f'F{flight_id:03d}',
        'flight_number': 'PENDING',
        'flight_match_key': 'PENDING',
        'etd': '',
        'etd_date': '',
        'cutoff': '',
        'destinations': sorted(set(a['dest_corrected'] for a in pending_awbs)),
        'airlines': sorted(set(a['deliver_to'] for a in pending_awbs if a['deliver_to'])),
        'awb_count': len(pending_awbs),
        'total_pcs': sum(a['pcs'] for a in pending_awbs),
        'total_cw': sum(a['cw'] for a in pending_awbs),
        'awbs': pending_awbs,
    })

# Print flights
for fl in expected_flights:
    year_warn = ''
    if fl['etd'] and not fl['etd'].startswith('202'):
        year_warn = ' *** BAD YEAR - should be flagged as alert ***'
    print(f'\n  {fl["id"]} | {fl["flight_number"]:>14} | ETD: {fl["etd"]:<22} | {fl["awb_count"]:>3} AWBs | Dest: {fl["destinations"]} | PCS: {fl["total_pcs"]:>5} | CW: {fl["total_cw"]:>10.1f}{year_warn}')
    print(f'       Airlines: {fl["airlines"]}  Cutoff: {fl["cutoff"]}')

print(f'\n  Total vuelos esperados: {len(expected_flights)}')
print(f'  Total AWBs en vuelos: {sum(f["awb_count"] for f in expected_flights)}')

# ============================================================
# EXPECTED BOOKINGS (1 booking per flight per client)
# ============================================================
print('\n' + '=' * 80)
print('BOOKINGS ESPERADOS (1 por vuelo, cliente: Express Line)')
print('=' * 80)

for fl in expected_flights:
    print(f'\n  Booking para {fl["id"]} ({fl["flight_number"]}, ETD {fl["etd_date"]}):')
    print(f'    flight_id: {fl["id"]}')
    print(f'    client: Express Line')
    print(f'    booking_type: ecommerce')
    print(f'    destination_id: {fl["destinations"][0] if fl["destinations"] else ""}')
    print(f'    awb_lines: {fl["awb_count"]}')
    print(f'    total_pieces: {fl["total_pcs"]}')

    for a in fl['awbs']:
        batt = 'Y' if a['battery'] else 'N'
        seg = a['segregation'] if a['segregation'] else '-'
        hs = a['hold_status']
        holds_count = len(a['holds'])
        a2 = a['awb2'] if a['awb2'] else '(none)'

        # Show differences current vs corrected
        diffs = []
        if a['dest_current'] != a['dest_corrected']:
            diffs.append(f'dest:{a["dest_current"]}->{a["dest_corrected"]}')
        if a['etd_current'] != a['etd_corrected']:
            diffs.append(f'etd:{a["etd_current"]}->{a["etd_corrected"]}')
        if a['cutoff_current'] != a['cutoff_corrected']:
            diffs.append(f'cutoff')
        if a['ready_current'] != a['ready_corrected']:
            diffs.append(f'ready')
        if a['pickup_issue']:
            diffs.append(f'pickup:INVALID')
        diff_str = f' [FIXES: {", ".join(diffs)}]' if diffs else ''

        print(f'      {a["awb1"]:>15} -> {a2:>15} | {a["pcs"]:>3}pcs {a["cw"]:>8.1f}kg | {a["uld"]:<5} | H:{hs:<7} ({holds_count}h) | B:{batt} S:{seg} | {a["deliver_to"]}{diff_str}')

# ============================================================
# EXPECTED HOLDS
# ============================================================
print('\n' + '=' * 80)
print('HOLDS ESPERADOS')
print('=' * 80)

all_holds = []
for r in eligible_corrected:
    if r['hold_status'] == 'HOLD':
        all_holds.append(r)

print(f'\n  AWBs con HOLD activo: {len(all_holds)}')
for r in all_holds:
    print(f'\n    R{r["row"]}: {r["awb1"]} (flight: {r["flight_corrected"]})')
    for i, h in enumerate(r['holds']):
        print(f'      Hold {i+1}: bag={h["bag"]} box={h["box"]}')

pending_holds = [r for r in eligible_corrected if r['hold_status'] == 'PENDING']
print(f'\n  AWBs con HOLD pending: {len(pending_holds)}')
for r in pending_holds:
    print(f'    R{r["row"]}: {r["awb1"]} (flight: {r["flight_corrected"]})')

# ============================================================
# DELIVER_TO ANALYSIS
# ============================================================
print('\n' + '=' * 80)
print('DELIVER_TO (usado como airline del vuelo)')
print('=' * 80)

deliver_to_map = defaultdict(set)
for r in eligible_corrected:
    dt = r['deliver_to']
    fn = r['flight_corrected']
    if dt:
        deliver_to_map[fn].add(dt)

for fn in sorted(deliver_to_map.keys()):
    dts = deliver_to_map[fn]
    warn = ' *** MULTIPLE VALUES' if len(dts) > 1 else ''
    print(f'  {fn}: {sorted(dts)}{warn}')

# ============================================================
# PICKUP_FROM ANALYSIS
# ============================================================
print('\n' + '=' * 80)
print('PICKUP_FROM VALIDACION')
print('=' * 80)

pickup_issues = [r for r in eligible_corrected if r['pickup_issue']]
if pickup_issues:
    print(f'  Issues detectados: {len(pickup_issues)}')
    for r in pickup_issues:
        print(f'    R{r["row"]}: {r["awb1"]} - {r["pickup_issue"]}')

# Unique pickup values
pickups = defaultdict(int)
for r in eligible_corrected:
    p = r['pickup_corrected'] or '(empty)'
    pickups[p] += 1
print(f'\n  Valores unicos de pickup_from (corregidos):')
for p in sorted(pickups.keys()):
    note = ''
    if len(p) > 20:
        note = ' *** LONG VALUE (address?)'
    print(f'    {p}: {pickups[p]} AWBs{note}')

# ============================================================
# DATES COMPARISON: CURRENT vs CORRECTED
# ============================================================
print('\n' + '=' * 80)
print('FECHAS: ACTUAL vs CORREGIDO (muestra de diferencias)')
print('=' * 80)

date_diff_count = 0
for r in eligible_corrected:
    for field in ['etd', 'cutoff', 'ready']:
        cur = r[f'{field}_current']
        cor = r[f'{field}_corrected']
        if cur != cor:
            date_diff_count += 1
            if date_diff_count <= 20:
                print(f'  R{r["row"]} {field:>7}: "{cur}" -> "{cor}"')

print(f'\n  Total diferencias de fecha: {date_diff_count}')

# ============================================================
# DESTINATION COMPARISON
# ============================================================
print('\n' + '=' * 80)
print('DESTINOS: ACTUAL vs CORREGIDO')
print('=' * 80)

dest_changes = [(r, r['dest_current'], r['dest_corrected']) for r in eligible_corrected if r['dest_current'] != r['dest_corrected']]
print(f'  Cambios de destino: {len(dest_changes)}')
dest_change_groups = defaultdict(int)
for r, old, new in dest_changes:
    dest_change_groups[f'{old} -> {new}'] += 1
for change, count in sorted(dest_change_groups.items()):
    print(f'    {change}: {count} AWBs')

# ============================================================
# FLIGHT DEDUPLICATION: CURRENT vs CORRECTED
# ============================================================
print('\n' + '=' * 80)
print('VUELOS: ACTUAL vs CORREGIDO (deduplicacion)')
print('=' * 80)

# Current: group by exact flight name + ETD date
current_flights = defaultdict(list)
for r in eligible_current:
    fn = r['flight_current']
    etd_date = (r['etd_current'] or '')[:10]
    key = f'{fn}|{etd_date}'
    current_flights[key].append(r)

print(f'  Vuelos ACTUALES (flight+ETD exacto): {len(current_flights)}')
print(f'  Vuelos CORREGIDOS (flight normalizado+ETD): {len(expected_flights)}')

# Identify merges
merged = defaultdict(list)
for group_key in current_flights:
    fn, etd = group_key.split('|')
    fkey = flight_match_key(fn)
    merged[f'{fkey}|{etd}'].append(group_key)

merge_events = {k: v for k, v in merged.items() if len(v) > 1}
if merge_events:
    print(f'\n  Vuelos que se FUSIONARIAN:')
    for norm_key, originals in merge_events.items():
        print(f'    {norm_key}: fusiona {originals}')

# ============================================================
# SEGREGATION EXPECTED
# ============================================================
print('\n' + '=' * 80)
print('SEGREGACION ESPERADA (nuevo campo)')
print('=' * 80)

seg_awbs = [r for r in eligible_corrected if r['segregation']]
print(f'  AWBs con segregacion: {len(seg_awbs)}')
for r in seg_awbs:
    print(f'    R{r["row"]}: {r["awb1"]} | flight={r["flight_corrected"]} | segregation="{r["segregation"]}" | dest={r["dest_corrected"]}')

# ============================================================
# FINAL SUMMARY
# ============================================================
print('\n' + '=' * 80)
print('RESUMEN FINAL - ESTADO ESPERADO DEL SISTEMA')
print('=' * 80)
print(f'''
  Vuelos totales: {len(expected_flights)} (vs {len(current_flights)} actual)
  AWBs totales: {sum(f["awb_count"] for f in expected_flights)} (vs {len(eligible_current)} actual)
  AWBs recuperados: {len(eligible_corrected) - len(eligible_current)}
  Bookings: {len(expected_flights)} (1 por vuelo)
  Holds activos: {len(all_holds)}
  Holds pending: {len(pending_holds)}
  Diferencias de fecha: {date_diff_count}
  Cambios de destino: {len(dest_changes)}
  Vuelos fusionados: {len(merge_events)}
  AWBs con segregacion: {len(seg_awbs)}
  Pickup issues: {len(pickup_issues)}
  Year issues: {len(year_issues)}
''')

if year_issues:
    print('  Alertas de ano incorrecto:')
    for yi in year_issues:
        print(f'    {yi}')

print('\n  Para completar la validacion, necesito un export del sistema actual.')
print('  Formato: JSON o CSV con todos los bookings de Express Line (client_id, flight_id,')
print('  flight_number, etd, destination, awb_lines con awb_number, awb_2nd_leg, pieces,')
print('  chargeable_weight, uld_type, hold, holds, battery, pickup_from, etc.)')
